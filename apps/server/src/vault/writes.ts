import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  linkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  extname,
  join,
  matchesGlob,
  posix,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Config } from "../config";
import { transaction } from "../db/transaction";
import { assertRelative, hash, isIgnored } from "./scanner";
import {
  addFrontmatter,
  appendText,
  PatchError,
  replaceRange,
  setFrontmatterList,
  setFrontmatterScalar,
  toggleCheckbox,
} from "../../../../packages/core/src/patch";
import { frontmatter } from "../../../../packages/core/src/parse/frontmatter";

export type WriteOp =
  | { type: "replaceFile" | "createFile" | "appendText"; text: string }
  | { type: "setScalar"; key: string; value: string; expect: unknown }
  | { type: "setList"; key: string; items: string[]; expect: unknown }
  | {
      type: "toggleCheckbox";
      offset: number;
      checked: boolean;
      expectedChecked: boolean;
    }
  | { type: "moveFile"; to: string }
  | { type: "trash" }
  | { type: "addFrontmatter"; fields: Record<string, string | string[]> }
  | {
      type: "replaceRange";
      start: number;
      end: number;
      expectText: string;
      newText: string;
    };

const authorization = {
  editor: ["replaceFile"],
  metadata: ["setScalar", "setList"],
  checkbox: ["toggleCheckbox"],
  note: ["createFile", "appendText", "replaceFile", "moveFile", "trash"],
  restore: ["replaceFile"],
  changeset: [
    "addFrontmatter",
    "replaceRange",
    "setScalar",
    "setList",
    "toggleCheckbox",
    "moveFile",
    "replaceFile",
  ],
} satisfies Record<string, WriteOp["type"][]>;

export interface WriteRequest {
  trigger: keyof typeof authorization;
  path: string;
  baseHash: string | null;
  op: WriteOp;
  changeItemId?: string;
}

const authorizedAction = new AsyncLocalStorage<{
  trigger: WriteRequest["trigger"];
  path: string;
  recovery: boolean;
}>();
/** Read-only diagnostic context for the filesystem authorization harness. */
export const currentVaultAction = () => authorizedAction.getStore();

export interface WriteResult {
  id: string | null;
  path: string;
  hash: string;
  backupPath: string | null;
}

export class WriteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: object,
  ) {
    super(message);
  }
}

function conflict(
  message = "This file changed on disk. Compare the current version before saving.",
  details?: object,
): never {
  throw new WriteError(409, "CONFLICT", message, details);
}

type Stage =
  "prepared" | "temp-synced" | "before-publish" | "published" | "move-staged";
export interface WriteHooks {
  /** A test may throw at a boundary to emulate process termination. */
  checkpoint?: (stage: Stage, request: WriteRequest) => void;
  audit?: (
    trigger: WriteRequest["trigger"] | "recovery",
    action: string,
    relative: string,
  ) => void;
}

type Journal = {
  id: string;
  path: string;
  target_path: string | null;
  base_hash: string | null;
  new_hash: string;
  tmp_path: string;
  backup_path: string | null;
  op: string;
  change_item_id: string | null;
  created_at: number;
};

const dirFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const openFileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const exclusive =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_NOFOLLOW;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const errorIs = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException)?.code === code;
const fdPath = (fd: number) => "/proc/" + process.pid + "/fd/" + fd;

/**
 * Pin each directory before resolving its child. An editor replacing a directory
 * with a symlink cannot redirect a subsequent open/rename outside the chosen root.
 */
function directory(
  root: string,
  relative: string,
  mkdir?: (path: string) => void,
) {
  let fd = openSync(root, dirFlags);
  let absolute = root;
  try {
    if (readlinkSync(fdPath(fd)) !== root)
      throw new WriteError(403, "FORBIDDEN_PATH", "Storage root has moved.");
    if (relative !== ".")
      for (const name of relative.split("/")) {
        if (!name || name === "." || name === "..")
          throw new WriteError(403, "FORBIDDEN_PATH", "Invalid directory.");
        const child = join(fdPath(fd), name);
        let next: number;
        try {
          next = openSync(child, dirFlags);
        } catch (e) {
          if (!mkdir || !errorIs(e, "ENOENT")) throw e;
          mkdir(posix.relative(root, join(absolute, name)));
          try {
            mkdirSync(child, { mode: 0o700 });
            fsyncSync(fd);
          } catch (e) {
            if (!errorIs(e, "EEXIST")) throw e;
          }
          next = openSync(child, dirFlags);
        }
        closeSync(fd);
        fd = next;
        absolute = join(absolute, name);
      }
    const verify = () => {
      if (readlinkSync(fdPath(fd)) !== absolute)
        throw new WriteError(
          403,
          "FORBIDDEN_PATH",
          "Directory moved during the operation.",
        );
    };
    verify();
    return {
      fd,
      verify,
      child: (name: string) => join(fdPath(fd), name),
      close: () => closeSync(fd),
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

type Directory = ReturnType<typeof directory>;

function snapshot(location: string) {
  let fd: number;
  try {
    fd = openSync(location, openFileFlags);
  } catch (e) {
    if (errorIs(e, "ENOENT")) return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      throw new WriteError(
        403,
        "FORBIDDEN_PATH",
        "Only regular Markdown files may be edited.",
      );
    const bytes = readFileSync(fd);
    return { bytes, hash: hash(bytes), mode: st.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function sameInode(a: string, b: string) {
  const left = lstatSync(a, { throwIfNoEntry: false });
  const right = lstatSync(b, { throwIfNoEntry: false });
  return Boolean(
    left && right && left.ino === right.ino && left.dev === right.dev,
  );
}

function durableCreate(location: string, data: Buffer, mode: number) {
  const fd = openSync(location, exclusive, mode);
  try {
    writeFileSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function mapFsError(e: unknown): never {
  if (e instanceof PatchError) throw new WriteError(422, e.code, e.message);
  if (errorIs(e, "ENOENT"))
    throw new WriteError(
      404,
      "NOT_FOUND",
      "The file or containing directory no longer exists.",
    );
  if (errorIs(e, "EEXIST"))
    throw new WriteError(
      409,
      "NAME_COLLISION",
      "A file already exists at that destination.",
    );
  if (
    ["ELOOP", "ENOTDIR", "EACCES", "EPERM"].some((code) => errorIs(e, code))
  ) {
    throw new WriteError(
      403,
      "FORBIDDEN_PATH",
      "The file is read-only or its path is unsafe.",
    );
  }
  throw e;
}

function apply(request: WriteRequest, current: ReturnType<typeof snapshot>) {
  const op = request.op;
  if (op.type === "createFile") {
    if (current)
      throw new WriteError(409, "NAME_COLLISION", "This file already exists.");
    return Buffer.from(op.text);
  }
  if (!current)
    throw new WriteError(404, "NOT_FOUND", "The file no longer exists.");
  if (!(current.mode & 0o222))
    throw new WriteError(403, "NOT_ALLOWED", "The file is read-only.");
  const text = utf8.decode(current.bytes);
  const stale = request.baseHash !== current.hash;
  if (op.type === "setList" || op.type === "setScalar") {
    if (stale && request.trigger === "changeset") conflict();
    const field = frontmatter(text).meta[op.key];
    if (!isDeepStrictEqual(field ?? null, op.expect ?? null))
      conflict("The metadata field changed on disk.", {
        field: op.key,
        theirs: field ?? null,
      });
    return Buffer.from(
      op.type === "setScalar"
        ? setFrontmatterScalar(text, op.key, op.value)
        : setFrontmatterList(text, op.key, op.items),
    );
  }
  if (stale) conflict(undefined, { hash: current.hash, theirs: text });
  switch (op.type) {
    case "replaceFile":
      return Buffer.from(op.text);
    case "appendText":
      return Buffer.from(appendText(text, op.text));
    case "toggleCheckbox":
      return Buffer.from(
        toggleCheckbox(text, op.offset, op.expectedChecked, op.checked),
      );
    case "addFrontmatter":
      return Buffer.from(addFrontmatter(text, op.fields));
    case "replaceRange":
      return Buffer.from(
        replaceRange(text, op.start, op.end, op.expectText, op.newText),
      );
    case "moveFile":
    case "trash":
      return current.bytes;
  }
}

export class WriteCoordinator {
  private locks = new Map<string, Promise<void>>();
  private lastWrite = new Map<string, number>();
  private lastPrune = 0;
  readonly recoveryIssues: { path: string; message: string }[] = [];
  constructor(
    readonly config: Config,
    private readonly db: DatabaseSync,
    private readonly refresh: (
      origin: "app" | "changeset",
    ) => Promise<unknown> = async () => {},
    private readonly hooks: WriteHooks = {},
  ) {}

  private checkedPath(path: string, trash = false) {
    const body = trash && path.startsWith(".trash/") ? path.slice(7) : path;
    assertRelative(body);
    if (
      extname(body).toLowerCase() !== ".md" ||
      body.includes(".sync-conflict-") ||
      this.config.ignore.some((pattern) => matchesGlob(path, pattern))
    ) {
      throw new WriteError(
        403,
        "FORBIDDEN_PATH",
        "This path is excluded from editing.",
      );
    }
  }

  private async locked<T>(
    paths: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(paths)].sort();
    const prior = keys.map((key) => this.locks.get(key) ?? Promise.resolve());
    let finish!: () => void;
    const current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const key of keys) this.locks.set(key, current);
    try {
      await Promise.all(prior);
      return await operation();
    } finally {
      finish();
      for (const key of keys)
        if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  private authorize(request: WriteRequest) {
    if (!this.config.allowVaultWrites)
      throw new WriteError(
        403,
        "NOT_ALLOWED",
        "Vault writes are disabled in the local configuration.",
      );
    if (
      !Object.hasOwn(authorization, request.trigger) ||
      !(authorization[request.trigger] as readonly string[]).includes(
        request.op.type,
      )
    ) {
      throw new WriteError(
        403,
        "NOT_ALLOWED",
        "This action cannot perform that file operation.",
      );
    }
    this.checkedPath(request.path);
    if (
      request.op.type === "createFile"
        ? request.baseHash !== null
        : !/^[a-f0-9]{64}$/.test(request.baseHash ?? "")
    ) {
      throw new WriteError(
        422,
        "VALIDATION",
        "An exact base version is required.",
      );
    }
    if (request.op.type === "moveFile") this.checkedPath(request.op.to);
    if (request.trigger === "changeset") {
      const item = this.db
        .prepare(
          "SELECT approved,state,path,target_path,base_hash,after_hash,op_json,backup_path FROM change_item WHERE id=?",
        )
        .get(request.changeItemId ?? "");
      const forward =
        item?.state === "proposed" &&
        item.path === request.path &&
        item.base_hash === request.baseHash;
      const reverse =
        item?.state === "applied" &&
        (item.target_path ?? item.path) === request.path &&
        item.after_hash === request.baseHash;
      if (!item?.approved || !(forward || reverse))
        throw new WriteError(
          403,
          "NOT_ALLOWED",
          "This change-set item has no matching approval.",
        );
      if (forward) {
        const planned = JSON.parse(String(item.op_json));
        if (!isDeepStrictEqual(planned.op ?? planned, request.op))
          throw new WriteError(
            403,
            "NOT_ALLOWED",
            "This operation differs from the approved preview.",
          );
      } else if (item.target_path) {
        if (request.op.type !== "moveFile" || request.op.to !== item.path)
          throw new WriteError(
            403,
            "NOT_ALLOWED",
            "Revert must restore the original location.",
          );
      } else if (
        request.op.type !== "replaceFile" ||
        hash(request.op.text) !== item.base_hash
      ) {
        throw new WriteError(
          403,
          "NOT_ALLOWED",
          "Revert must restore the original file bytes.",
        );
      }
    }
    if (request.trigger === "note") {
      const destination =
        request.op.type === "createFile"
          ? request.path
          : request.op.type === "moveFile"
            ? request.op.to
            : null;
      if (
        destination &&
        !destination.startsWith(this.config.personalNotes.root + "/")
      ) {
        throw new WriteError(
          403,
          "FORBIDDEN_PATH",
          "New personal-note locations must be inside the configured notes folder.",
        );
      }
    }
    if (request.op.type === "moveFile" && request.op.to === request.path)
      throw new WriteError(422, "VALIDATION", "Pick a different destination.");
  }

  private uniqueBasename(destination: string, except: string | null) {
    const title = basename(destination).toLowerCase();
    const walk = (folder: string) => {
      const dir = directory(this.config.vaultPath, folder || ".");
      try {
        for (const entry of readdirSync(fdPath(dir.fd), {
          withFileTypes: true,
        })) {
          const relative = folder ? folder + "/" + entry.name : entry.name;
          if (
            isIgnored(entry.name) ||
            this.config.ignore.some((glob) => matchesGlob(relative, glob)) ||
            entry.isSymbolicLink()
          )
            continue;
          if (entry.isDirectory()) walk(relative);
          else if (
            entry.isFile() &&
            entry.name.toLowerCase() === title &&
            relative !== except
          ) {
            throw new WriteError(
              409,
              "NAME_COLLISION",
              "A note with this name already exists in the vault.",
            );
          }
        }
      } finally {
        dir.close();
      }
    };
    walk("");
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    this.authorize(request);
    const id = randomUUID();
    const target =
      request.op.type === "moveFile"
        ? request.op.to
        : request.op.type === "trash"
          ? ".trash/" + id + "/" + basename(request.path)
          : null;
    const paths = target ? [request.path, target] : [request.path];
    if (request.op.type === "createFile" || request.op.type === "moveFile")
      paths.push(":note-names");
    return this.locked(paths, async () => {
      this.authorize(request);
      try {
        if (
          request.trigger === "note" &&
          (request.op.type === "createFile" || request.op.type === "moveFile")
        ) {
          this.uniqueBasename(
            target ?? request.path,
            request.op.type === "createFile" ? null : request.path,
          );
        }
        const last = this.lastWrite.get(request.path);
        if (last !== undefined && Date.now() - last < 250)
          await delay(Math.max(0, 250 - (Date.now() - last)));
        const result = authorizedAction.run(
          { trigger: request.trigger, path: request.path, recovery: false },
          () => this.commit(id, request, target),
        );
        if (result.id) {
          this.lastWrite.set(request.path, Date.now());
          await this.refresh(
            request.trigger === "changeset" ? "changeset" : "app",
          );
          if (Date.now() - this.lastPrune > 86400000) {
            this.prune();
            this.lastPrune = Date.now();
          }
        }
        return result;
      } catch (e) {
        return mapFsError(e);
      }
    });
  }

  private commit(
    id: string,
    request: WriteRequest,
    target: string | null,
  ): WriteResult {
    const audit = (action: string, path: string) =>
      this.hooks.audit?.(request.trigger, action, path);
    const make = (path: string) => audit("mkdir", path);
    const root = this.config.vaultPath;
    const sourceDir = directory(
      root,
      dirname(request.path),
      request.op.type === "createFile" ? make : undefined,
    );
    let targetDir: Directory | null = null;
    let journaled = false;
    let fault = false;
    const boundary = (stage: Stage) => {
      try {
        this.hooks.checkpoint?.(stage, request);
      } catch (error) {
        fault = true;
        throw error;
      }
    };
    try {
      const source = sourceDir.child(basename(request.path));
      const old = snapshot(source);
      if (
        request.trigger === "note" &&
        old &&
        !request.path.startsWith(this.config.personalNotes.root + "/") &&
        !/ - notes\.md$/i.test(request.path) &&
        !/^99 - Inbox\/.+\/.+\.md$/i.test(request.path) &&
        frontmatter(utf8.decode(old.bytes)).meta.type !== "note"
      ) {
        throw new WriteError(
          403,
          "NOT_ALLOWED",
          "This operation is available for personal notes only.",
        );
      }
      const bytes = apply(request, old);
      const newHash = hash(bytes);
      if (!target && old?.hash === newHash)
        return {
          id: null,
          path: request.path,
          hash: newHash,
          backupPath: null,
        };
      if (target) {
        this.checkedPath(target, request.op.type === "trash");
        targetDir = directory(root, dirname(target), make);
        if (
          lstatSync(targetDir.child(basename(target)), {
            throwIfNoEntry: false,
          })
        )
          throw new WriteError(
            409,
            "NAME_COLLISION",
            "The destination already exists.",
          );
      }
      const tempName = "." + basename(request.path) + ".synapse-tmp-" + id;
      const tmp = sourceDir.child(tempName);
      const tempPath = posix.join(dirname(request.path), tempName);
      const backupPath = old
        ? posix.join(
            "backups/files",
            request.path,
            id + "-" + old.hash.slice(0, 8) + ".md",
          )
        : null;
      if (backupPath && old) {
        const backups = directory(
          this.config.dataDir,
          dirname(backupPath),
          () => {},
        );
        try {
          durableCreate(backups.child(basename(backupPath)), old.bytes, 0o600);
          fsyncSync(backups.fd);
        } finally {
          backups.close();
        }
      }
      this.db
        .prepare(
          `INSERT INTO write_journal(id,path,target_path,base_hash,new_hash,tmp_path,backup_path,op,change_item_id,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          id,
          request.path,
          target,
          old?.hash ?? null,
          newHash,
          tempPath,
          backupPath,
          request.trigger + "/" + request.op.type,
          request.changeItemId ?? null,
          Date.now(),
        );
      journaled = true;
      boundary("prepared");
      if (!target) {
        audit("create-temp", tempPath);
        durableCreate(tmp, bytes, old?.mode ?? 0o600);
        fsyncSync(sourceDir.fd);
        boundary("temp-synced");
      }
      sourceDir.verify();
      targetDir?.verify();
      if ((snapshot(source)?.hash ?? null) !== (old?.hash ?? null)) conflict();
      boundary("before-publish");
      sourceDir.verify();
      targetDir?.verify();
      if (target && targetDir) {
        const dest = targetDir.child(basename(target));
        audit("stage-move", request.path);
        renameSync(source, tmp);
        fsyncSync(sourceDir.fd);
        boundary("move-staged");
        if (snapshot(tmp)?.hash !== old?.hash) conflict();
        // link is atomic and refuses to replace a concurrent destination.
        audit("publish-move", target);
        linkSync(tmp, dest);
        fsyncSync(targetDir.fd);
      } else if (!old) {
        audit("publish-new", request.path);
        linkSync(tmp, source);
        fsyncSync(sourceDir.fd);
      } else {
        audit("publish-replacement", request.path);
        // util-linux exch preserves the displaced inode for one final comparison.
        // Systems without it use the specified fsync/recheck/rename protocol.
        if (existsSync("/usr/bin/exch")) {
          const result = spawnSync("/usr/bin/exch", ["--", tmp, source], {
            stdio: "ignore",
          });
          if (result.status !== 0)
            throw new WriteError(
              409,
              "CONFLICT",
              "Atomic exchange failed. The file may have moved.",
            );
          if (snapshot(tmp)?.hash !== old.hash) {
            if (snapshot(source)?.hash === newHash) {
              const restored = spawnSync("/usr/bin/exch", ["--", tmp, source], {
                stdio: "ignore",
              });
              if (restored.status !== 0)
                throw new WriteError(
                  409,
                  "CONFLICT",
                  "The external version is retained in the recovery file.",
                );
              fsyncSync(sourceDir.fd);
            }
            conflict(
              "An external edit arrived during replacement. Check the current and recovery versions.",
            );
          }
        } else {
          if (snapshot(source)?.hash !== old.hash) conflict();
          renameSync(tmp, source);
        }
        fsyncSync(sourceDir.fd);
      }
      boundary("published");
      if (existsSync(tmp)) {
        audit("remove-temp", tempPath);
        unlinkSync(tmp);
        fsyncSync(sourceDir.fd);
      }
      this.mark(id, "committed");
      return { id, path: target ?? request.path, hash: newHash, backupPath };
    } catch (e) {
      if (journaled && !fault) this.reconcile(this.row(id));
      throw e;
    } finally {
      sourceDir.close();
      targetDir?.close();
    }
  }

  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM write_journal WHERE id=?")
      .get(id) as unknown as Journal;
  }
  private mark(
    id: string,
    state: "committed" | "rolled_back" | "failed",
    error: string | null = null,
  ) {
    transaction(this.db, () => {
      const row = this.row(id);
      if (
        state === "committed" &&
        row.target_path &&
        !row.target_path.startsWith(".trash/")
      ) {
        const oldKey = row.path.replace(/\.md$/i, "");
        const newKey = row.target_path.replace(/\.md$/i, "");
        const identity = this.db
          .prepare("SELECT nid FROM node_identity WHERE node_key=?")
          .get(oldKey);
        if (identity) {
          // Preserve activity even if an older detached record once occupied the destination.
          const former = this.db
            .prepare("SELECT nid FROM node_identity WHERE node_key=?")
            .get(newKey);
          const alias = this.db.prepare(
            "INSERT OR REPLACE INTO node_alias(nid,old_key,renamed_at) VALUES(?,?,?)",
          );
          if (former) {
            alias.run(former.nid!, newKey, Date.now());
            this.db
              .prepare(
                "UPDATE node_identity SET node_key=?,slug=?,deleted_at=? WHERE nid=?",
              )
              .run(
                "@detached/" + former.nid,
                "@" + former.nid,
                Date.now(),
                former.nid!,
              );
          }
          alias.run(identity.nid!, oldKey, Date.now());
          this.db
            .prepare("UPDATE node_identity SET node_key=? WHERE nid=?")
            .run(newKey, identity.nid!);
        }
      }
      this.db
        .prepare(
          "UPDATE write_journal SET state=?,finished_at=?,error=? WHERE id=?",
        )
        .run(state, Date.now(), error, id);
    });
  }

  private reconcile(row: Journal) {
    const notes = (message: string) => {
      this.mark(row.id, "failed", message);
      this.recoveryIssues.push({ path: row.path, message });
    };
    let sourceDir: Directory | undefined;
    let destDir: Directory | undefined;
    try {
      this.checkedPath(row.path);
      sourceDir = directory(this.config.vaultPath, dirname(row.path));
      const source = sourceDir.child(basename(row.path));
      const expectedTemp = posix.join(
        dirname(row.path),
        "." + basename(row.path) + ".synapse-tmp-" + row.id,
      );
      if (row.tmp_path !== expectedTemp)
        return notes("Recovery path does not match the journal.");
      const tmp = sourceDir.child(basename(expectedTemp));
      const current = snapshot(source)?.hash ?? null;
      const staged = snapshot(tmp)?.hash ?? null;
      const clean = () => {
        if (!staged) return;
        this.hooks.audit?.("recovery", "remove-temp", expectedTemp);
        unlinkSync(tmp);
        fsyncSync(sourceDir!.fd);
      };
      if (row.target_path) {
        this.checkedPath(row.target_path, row.op === "note/trash");
        destDir = directory(this.config.vaultPath, dirname(row.target_path));
        const target = destDir.child(basename(row.target_path));
        const dest = snapshot(target)?.hash;
        if (
          dest === row.new_hash &&
          current === null &&
          (staged === null ||
            (staged === row.base_hash && sameInode(tmp, target)))
        ) {
          clean();
          this.mark(row.id, "committed");
          return;
        }
        if (current === null && staged !== null) {
          this.hooks.audit?.("recovery", "restore-move", row.path);
          linkSync(tmp, source);
          fsyncSync(sourceDir.fd);
          clean();
          if (staged === row.base_hash) this.mark(row.id, "rolled_back");
          else
            notes(
              "An external file change interrupted the move. Its bytes were restored at the original location.",
            );
          return;
        }
        if (current === row.base_hash && staged === null) {
          this.mark(row.id, "rolled_back");
          return;
        }
      } else {
        if (
          current === row.new_hash &&
          (staged === null ||
            staged === row.base_hash ||
            (staged === row.new_hash && sameInode(tmp, source)))
        ) {
          clean();
          this.mark(row.id, "committed");
          return;
        }
        if (
          current === row.base_hash &&
          (staged === null || staged === row.new_hash)
        ) {
          clean();
          this.mark(row.id, "rolled_back");
          return;
        }
        if (staged === row.new_hash) clean();
      }
      notes(
        "External changes were detected. Compare the current file and its protected backup.",
      );
    } catch {
      notes(
        "Recovery could not inspect both versions. The journal and backup were retained.",
      );
    } finally {
      sourceDir?.close();
      destDir?.close();
    }
  }

  recover() {
    const rows = this.db
      .prepare(
        "SELECT * FROM write_journal WHERE state='pending' ORDER BY created_at,id",
      )
      .all() as unknown as Journal[];
    for (const row of rows) {
      const trigger = row.op.split("/")[0] as WriteRequest["trigger"];
      if (!Object.hasOwn(authorization, trigger)) {
        this.recoveryIssues.push({
          path: row.path,
          message: "The journal trigger could not be verified.",
        });
        continue;
      }
      if (this.config.allowVaultWrites)
        authorizedAction.run({ trigger, path: row.path, recovery: true }, () =>
          this.reconcile(row),
        );
      else
        this.recoveryIssues.push({
          path: row.path,
          message: "Pending write recovery requires writable configuration.",
        });
    }
    for (const row of this.db
      .prepare("SELECT path,error FROM write_journal WHERE state='failed'")
      .all()) {
      if (!this.recoveryIssues.some((i) => i.path === row.path))
        this.recoveryIssues.push({
          path: String(row.path),
          message: String(row.error),
        });
    }
    return this.recoveryIssues;
  }

  history(path: string) {
    this.checkedPath(path);
    return this.db
      .prepare(
        "SELECT id,path,base_hash AS hash,created_at AS at,op AS trigger FROM write_journal WHERE path=? AND backup_path IS NOT NULL ORDER BY created_at DESC,id DESC",
      )
      .all(path);
  }

  version(path: string, id: string): string {
    this.checkedPath(path);
    const row = this.row(id);
    if (!row || row.path !== path || !row.backup_path || !row.base_hash)
      throw new WriteError(404, "NOT_FOUND", "Backup version not found.");
    const expected = posix.join(
      "backups/files",
      path,
      id + "-" + row.base_hash.slice(0, 8) + ".md",
    );
    if (row.backup_path !== expected)
      throw new WriteError(
        403,
        "FORBIDDEN_PATH",
        "Unexpected backup location.",
      );
    const dir = directory(this.config.dataDir, dirname(expected));
    try {
      const backup = snapshot(dir.child(basename(expected)));
      if (backup?.hash !== row.base_hash)
        conflict("Backup verification failed.");
      return utf8.decode(backup.bytes);
    } finally {
      dir.close();
    }
  }

  restore(path: string, id: string, baseHash: string) {
    const text = this.version(path, id);
    return this.write({
      trigger: "restore",
      path,
      baseHash,
      op: { type: "replaceFile", text },
    });
  }

  /** Leave pending, failed, and young change-set evidence intact. */
  private prune() {
    const rows = this.db
      .prepare(
        "SELECT * FROM write_journal WHERE state='committed' AND backup_path IS NOT NULL ORDER BY created_at DESC,id DESC",
      )
      .all() as unknown as Journal[];
    const counts = new Map<string, number>();
    let retained = 0;
    for (const row of rows) {
      const day = (Date.now() - row.created_at) / 86400000;
      const count = (counts.get(row.path) ?? 0) + 1;
      counts.set(row.path, count);
      const expected = posix.join(
        "backups/files",
        row.path,
        row.id + "-" + row.base_hash?.slice(0, 8) + ".md",
      );
      if (row.backup_path !== expected) continue;
      const dir = directory(this.config.dataDir, dirname(expected));
      try {
        const full = dir.child(basename(expected));
        const stat = lstatSync(full, { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        retained += stat.size;
        if (
          (row.change_item_id && day < 90) ||
          ((day < 30 || count <= 50) && retained <= 500 * 1024 ** 2)
        )
          continue;
        unlinkSync(full);
        this.db
          .prepare("UPDATE write_journal SET backup_path=NULL WHERE id=?")
          .run(row.id);
      } finally {
        dir.close();
      }
    }
  }
}
