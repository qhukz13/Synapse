import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import subprocess from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configFrom } from "../config";
import { openState } from "../db";
import { hash } from "./scanner";
import {
  WriteCoordinator,
  currentVaultAction,
  type WriteHooks,
  type WriteRequest,
} from "./writes";

const initial =
  '---\r\ntype: note\r\nstatus: "unread" # current\r\n---\r\n# Read this\r\n';
const file = "Topics/Lesson.md";
const halted = new Error("Injected agent termination");

function rig(hooks: WriteHooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), "synapse-write-test-"));
  const vault = join(dir, "vault");
  mkdirSync(join(vault, "Topics"), { recursive: true });
  const absolute = (path: string) => join(vault, path);
  const seed = (path: string, text: string) => {
    mkdirSync(dirname(absolute(path)), { recursive: true });
    writeFileSync(absolute(path), text);
  };
  seed(file, initial);
  const config = configFrom({
    vaultPath: vault,
    dataDir: join(dir, "data"),
    allowVaultWrites: true,
  });
  let state = openState(config);
  const origins: string[] = [];
  const refresh = async (origin: "app" | "changeset") => {
    origins.push(origin);
  };
  let writer = new WriteCoordinator(config, state.db, refresh, hooks);
  const restart = (writable = true) => {
    state.close();
    state = openState(config);
    writer = new WriteCoordinator(
      { ...config, allowVaultWrites: writable },
      state.db,
      refresh,
    );
    return writer.recover();
  };
  const dispose = () => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir,
    config,
    origins,
    absolute,
    seed,
    restart,
    dispose,
    get state() {
      return state;
    },
    get writer() {
      return writer;
    },
    text: (path: string = file) => readFileSync(absolute(path), "utf8"),
  };
}
function editor(text: string, baseHash = hash(initial)): WriteRequest {
  return {
    trigger: "editor",
    path: file,
    baseHash,
    op: { type: "replaceFile", text },
  };
}
function metadata(): WriteRequest {
  return {
    trigger: "metadata",
    path: file,
    baseHash: hash(initial),
    op: {
      type: "setScalar",
      key: "status",
      expect: "unread",
      value: "learning",
    },
  };
}
const create = (path: string, text: string): WriteRequest => ({
  trigger: "note",
  path,
  baseHash: null,
  op: { type: "createFile", text },
});
const movedPath = "Personal Notes/General/Lesson.md";
const move = (): WriteRequest => ({
  trigger: "note",
  path: file,
  baseHash: hash(initial),
  op: { type: "moveFile", to: movedPath },
});

const rounds = Number(process.env.SYNAPSE_WRITE_TEST_ROUNDS ?? "1");
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100)
  throw new Error("Use 1–100 isolated test rounds.");
describe.each(Array.from({ length: rounds }, (_, n) => n + 1))(
  "coordinated vault writes · round %i",
  () => {
    let r: ReturnType<typeof rig> | undefined;
    afterEach(() => {
      r?.dispose();
      r = undefined;
    });

    it("updates only the selected field, rebases over external body changes and restores the exact backup", async () => {
      r = rig();
      const disk = initial + "\r\nWritten externally.";
      r.seed(file, disk);
      const changed = await r.writer.write(metadata());
      expect(r.text()).toBe(disk.replace('"unread"', '"learning"'));
      expect(r.writer.version(file, changed.id!)).toBe(disk);
      expect(r.writer.history(file)).toHaveLength(1);
      await r.writer.restore(file, changed.id!, changed.hash);
      expect(r.text()).toBe(disk);
      expect(r.origins).toEqual(["app", "app"]);
    });

    it("rejects competing metadata changes and stale editor text without discarding either version", async () => {
      r = rig();
      const external = initial.replace("unread", "understood");
      r.seed(file, external);
      await expect(r.writer.write(metadata())).rejects.toMatchObject({
        statusCode: 409,
        details: { theirs: "understood" },
      });
      await expect(r.writer.write(editor("new draft"))).rejects.toMatchObject({
        statusCode: 409,
        details: { theirs: external },
      });
      expect(r.text()).toBe(external);
      expect(r.writer.history(file)).toHaveLength(0);
    });

    it("recognizes a Syncthing-style swap in the temp write window and preserves the external file", async () => {
      const external = initial + "new from peer";
      r = rig({
        checkpoint(stage) {
          if (stage !== "temp-synced") return;
          const tmp = r!.absolute("Topics/.syncthing.test.tmp");
          writeFileSync(tmp, external);
          renameSync(tmp, r!.absolute(file));
        },
      });
      await expect(r.writer.write(editor("draft"))).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(r.text()).toBe(external);
      expect(readdirSync(r.absolute("Topics"))).toEqual(["Lesson.md"]);
    });

    it("preserves a second external edit at the publication boundary", async () => {
      const external = initial + "just arrived";
      r = rig({
        checkpoint(stage) {
          if (stage === "before-publish") r!.seed(file, external);
        },
      });
      await expect(r.writer.write(editor("new version"))).rejects.toMatchObject(
        { statusCode: 409 },
      );
      expect(r.text()).toBe(external);
      expect(readdirSync(r.absolute("Topics"))).toEqual(["Lesson.md"]);
    });

    it.each(["prepared", "temp-synced", "published"] as const)(
      "recovers %s from durable journal and files",
      async (stage) => {
        r = rig({
          checkpoint(point) {
            if (point === stage) throw halted;
          },
        });
        await expect(r.writer.write(editor("replacement"))).rejects.toBe(
          halted,
        );
        expect(
          r.state.db.prepare("SELECT state FROM write_journal").get()?.state,
        ).toBe("pending");
        expect(r.restart()).toEqual([]);
        expect(r.text()).toBe(stage === "published" ? "replacement" : initial);
        expect(
          r.state.db.prepare("SELECT state FROM write_journal").get()?.state,
        ).toBe(stage === "published" ? "committed" : "rolled_back");
        expect(readdirSync(r.absolute("Topics"))).toEqual(["Lesson.md"]);
      },
    );

    it("serializes 50 concurrent editors and writes once, with a verified undo version", async () => {
      r = rig();
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, n) =>
          r!.writer.write(editor("edit " + n)),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failures = results.filter((result) => result.status === "rejected");
      expect(failures).toHaveLength(49);
      expect(failures.every((result) => result.reason.statusCode === 409)).toBe(
        true,
      );
      expect(r.text()).toBe("edit 0");
      expect(r.writer.history(file)).toHaveLength(1);
      expect(readdirSync(r.absolute("Topics"))).toEqual(["Lesson.md"]);
    });

    it("refuses unapproved triggers, path escape, read-only configuration and file permissions", async () => {
      r = rig();
      const write = (request: WriteRequest) => r!.writer.write(request);
      await expect(
        write({ ...editor("oops"), trigger: "metadata" }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        write({
          ...editor("oops"),
          trigger: "changeset",
          changeItemId: "absent",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        write({ ...editor("oops"), path: "../outside.md" }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        write(create("Elsewhere/New.md", "text")),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        write({ ...editor("oops"), path: "Topics/Changed.js" }),
      ).rejects.toMatchObject({ statusCode: 403 });
      chmodSync(r.absolute(file), 0o444);
      await expect(write(editor("oops"))).rejects.toMatchObject({
        statusCode: 403,
      });
      unlinkSync(r.absolute(file));
      await expect(write(editor("oops"))).rejects.toMatchObject({
        statusCode: 404,
      });
      r.restart(false);
      await expect(
        write(create("Personal Notes/General/First.md", "new")),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(r.writer.history(file)).toHaveLength(0);
    });

    it("refuses symlinked files and parents, including newly created note locations", async () => {
      r = rig();
      const out = join(r.dir, "outside.md");
      writeFileSync(out, initial);
      symlinkSync(out, r.absolute("Topics/Link.md"));
      symlinkSync(r.dir, r.absolute("Personal Notes"));
      await expect(
        r.writer.write({ ...editor("bad"), path: "Topics/Link.md" }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        r.writer.write(create("Personal Notes/General/Bad.md", "bad")),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(readFileSync(out, "utf8")).toBe(initial);
      expect(existsSync(join(r.dir, "General"))).toBe(false);
    });

    it("creates notes exclusively, checks case-insensitive basenames and refuses to replace a concurrent new file", async () => {
      let race = false;
      r = rig({
        checkpoint(stage, request) {
          if (race && stage === "before-publish")
            r!.seed(request.path, "external");
        },
      });
      await expect(
        r.writer.write(create("Personal Notes/General/lesson.md", "text")),
      ).rejects.toMatchObject({ code: "NAME_COLLISION" });
      expect(existsSync(r.absolute("Personal Notes"))).toBe(false);
      const path = "Personal Notes/General/New.md";
      const created = await r.writer.write(create(path, "written"));
      expect(created.backupPath).toBeNull();
      expect(r.text(path)).toBe("written");
      race = true;
      await expect(
        r.writer.write(create("Personal Notes/General/Another.md", "ours")),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(r.text("Personal Notes/General/Another.md")).toBe("external");
    });

    it("moves into trash preserving all bytes, even if a same-named file was trashed previously", async () => {
      r = rig();
      const result = await r.writer.write({ ...move(), op: { type: "trash" } });
      expect(result.path.startsWith(".trash/")).toBe(true);
      expect(r.text(result.path)).toBe(initial);
      expect(existsSync(r.absolute(file))).toBe(false);
    });

    it("never overwrites an existing or racing move destination", async () => {
      r = rig({
        checkpoint(stage) {
          if (stage === "move-staged") r!.seed(movedPath, "external");
        },
      });
      await expect(r.writer.write(move())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(r.text()).toBe(initial);
      expect(r.text(movedPath)).toBe("external");
      await expect(r.writer.write(move())).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it.each(["move-staged", "published"] as const)(
      "recovers a move interrupted at %s",
      async (stage) => {
        r = rig({
          checkpoint(point) {
            if (point === stage) throw halted;
          },
        });
        await expect(r.writer.write(move())).rejects.toBe(halted);
        expect(r.restart()).toEqual([]);
        expect(r.text(stage === "published" ? movedPath : file)).toBe(initial);
        expect(
          existsSync(r.absolute(stage === "published" ? file : movedPath)),
        ).toBe(false);
        expect(
          readdirSync(r.absolute("Topics")).some((name) =>
            name.includes(".synapse-tmp-"),
          ),
        ).toBe(false);
      },
    );

    it("preserves unknown external changes across crash recovery and keeps previous bytes inspectable", async () => {
      r = rig({
        checkpoint(point) {
          if (point === "temp-synced") throw halted;
        },
      });
      await expect(r.writer.write(editor("draft"))).rejects.toBe(halted);
      r.seed(file, "external");
      expect(r.restart(false)).toHaveLength(1);
      expect(r.restart()).toHaveLength(1);
      expect(r.text()).toBe("external");
      expect(
        r.writer.version(file, String(r.writer.history(file)[0]?.id)),
      ).toBe(initial);
    });

    it("traces vault operations to a recognized user action or durable journal recovery", async () => {
      const calls: string[] = [];
      r = rig({
        audit(trigger, action, relative) {
          expect(trigger).toBe("note");
          expect(relative.includes("..")).toBe(false);
          calls.push(action);
        },
      });
      await r.writer.write(create("Personal Notes/General/New.md", "study"));
      expect(calls).toEqual([
        "mkdir",
        "mkdir",
        "create-temp",
        "publish-new",
        "remove-temp",
      ]);
      const before = [...calls];
      r.writer.recover();
      r.writer.history(file);
      expect(calls).toEqual(before);
    });
  },
);

describe.each(Array.from({ length: rounds }, (_, n) => n + 1))(
  "journal authorization and identity · round %i",
  () => {
    it("binds approved operations and reversals to one file and exact content", async () => {
      const r = rig();
      try {
        const db = r.state.db;
        const request: WriteRequest = {
          ...metadata(),
          trigger: "changeset",
          changeItemId: "i",
        };
        db.prepare(
          "INSERT INTO change_set VALUES('s','health-fix','Example',1,'draft')",
        ).run();
        db.prepare(
          `INSERT INTO change_item(id,change_set_id,path,op_json,evidence_json,base_hash,approved,state)
       VALUES('i','s',?,?,'[]',?,1,'proposed')`,
        ).run(file, JSON.stringify(request.op), hash(initial));
        await expect(
          r.writer.write({
            ...request,
            op: { type: "replaceFile", text: "unauthorized" },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const result = await r.writer.write(request);
        db.prepare(
          "UPDATE change_item SET state='applied',after_hash=?,backup_path=? WHERE id='i'",
        ).run(result.hash, result.backupPath);
        await expect(
          r.writer.write({
            ...request,
            baseHash: result.hash,
            op: { type: "replaceFile", text: "invalid" },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await r.writer.write({
          ...request,
          baseHash: result.hash,
          op: { type: "replaceFile", text: initial },
        });
        expect(r.text()).toBe(initial);
      } finally {
        r.dispose();
      }
    });

    it("repoints the same nid directly when a note moves, including on crash recovery", async () => {
      const r = rig({
        checkpoint(stage) {
          if (stage === "published") throw halted;
        },
      });
      try {
        r.state.db
          .prepare(
            `INSERT INTO node_identity(nid,node_key,slug,title,kind,first_seen,last_seen)
        VALUES('stable','Topics/Lesson','lesson','Lesson','note',1,1)`,
          )
          .run();
        await expect(r.writer.write(move())).rejects.toBe(halted);
        r.restart();
        expect(
          r.state.db.prepare("SELECT nid,node_key FROM node_identity").all(),
        ).toEqual([{ nid: "stable", node_key: movedPath.slice(0, -3) }]);
        expect(
          r.state.db.prepare("SELECT nid,old_key FROM node_alias").all(),
        ).toEqual([{ nid: "stable", old_key: "Topics/Lesson" }]);
      } finally {
        r.dispose();
      }
    });

    it("restores an arriving source edit during a move and preserves a same-content destination collision", async () => {
      let inject = "edit";
      const r = rig({
        checkpoint(stage) {
          if (inject === "edit" && stage === "before-publish")
            r.seed(file, "external");
          if (inject === "collision" && stage === "move-staged")
            r.seed(movedPath, initial);
        },
      });
      try {
        await expect(r.writer.write(move())).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(r.text()).toBe("external");
        r.seed(file, initial);
        inject = "collision";
        await expect(r.writer.write(move())).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(r.text()).toBe(initial);
        expect(r.text(movedPath)).toBe(initial);
      } finally {
        r.dispose();
      }
    });

    it("audits actual vault filesystem calls independently of the coordinator operation logger", async () => {
      const r = rig();
      const mutations: string[] = [];
      const watch = (location: unknown) => {
        const absolute =
          typeof location === "number"
            ? fs.readlinkSync("/proc/self/fd/" + location)
            : String(location);
        let target: string;
        try {
          target = fs.realpathSync(absolute);
        } catch {
          target = join(
            fs.realpathSync(dirname(absolute)),
            absolute.split("/").at(-1)!,
          );
        }
        if (!target.startsWith(r.config.vaultPath + "/")) return;
        const reason = currentVaultAction();
        if (!reason) throw new Error("Unattributed vault mutation");
        mutations.push(reason.trigger);
      };
      const originals = {
        openSync: fs.openSync,
        writeFileSync: fs.writeFileSync,
        linkSync: fs.linkSync,
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
        mkdirSync: fs.mkdirSync,
      };
      const spawn = subprocess.spawnSync;
      try {
        fs.openSync = (location, flags, mode) => {
          if (
            typeof flags === "number"
              ? (flags &
                  (fs.constants.O_CREAT |
                    fs.constants.O_WRONLY |
                    fs.constants.O_RDWR |
                    fs.constants.O_TRUNC)) !==
                0
              : /[wa+]/.test(flags)
          )
            watch(location);
          return originals.openSync(location, flags, mode);
        };
        fs.writeFileSync = (location, data, options) => {
          watch(location);
          return originals.writeFileSync(location, data, options);
        };
        fs.linkSync = (a, b) => {
          watch(b);
          return originals.linkSync(a, b);
        };
        fs.renameSync = (a, b) => {
          watch(a);
          watch(b);
          return originals.renameSync(a, b);
        };
        fs.unlinkSync = (a) => {
          watch(a);
          return originals.unlinkSync(a);
        };
        fs.mkdirSync = ((a: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
          watch(a);
          return originals.mkdirSync(a, options);
        }) as typeof fs.mkdirSync;
        subprocess.spawnSync = ((...args: Parameters<typeof spawn>) => {
          if (args[0] === "/usr/bin/exch" && Array.isArray(args[1]))
            for (const arg of args[1].slice(1)) watch(arg);
          return spawn(...args);
        }) as typeof spawn;
        syncBuiltinESMExports();
        expect(() =>
          fs.writeFileSync(r.absolute(file), "unattributed"),
        ).toThrow("Unattributed vault mutation");
        const updated = await r.writer.write(metadata());
        await r.writer.write(create("Personal Notes/General/Trail.md", "text"));
        await r.writer.write({ ...move(), baseHash: updated.hash });
        expect(new Set(mutations)).toEqual(new Set(["metadata", "note"]));
      } finally {
        Object.assign(fs, originals);
        subprocess.spawnSync = spawn;
        syncBuiltinESMExports();
        r.dispose();
      }
    });
  },
);
