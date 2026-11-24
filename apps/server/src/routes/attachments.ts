import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, extname, join, relative, isAbsolute, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  libraryExtensions,
  assertRelative,
  isIgnored,
  safeFile,
} from "../vault/scanner";
import { serveContent } from "../vault/content";
import type { Context } from "../app";
import { transaction } from "../db/transaction";

const unavailable = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const attachmentFields = `id,owner_nid,mode,root_id,rel_path,blob_sha256,display_name,original_name,file_kind,mime,size,sha256,availability,last_verified_at,created_at,note`;
const attachmentExtensions = new Set([...libraryExtensions, ".md", ".zip"]);

export function registerAttachments({
  app,
  config,
  state,
  topic,
  nid,
}: Context) {
  const roots = () => [
    { id: "vault", path: config.vaultPath, kind: "reference" as const },
    ...config.attachments.extraRoots.map((root) => ({
      id: root.id,
      path: root.path,
      kind: "reference" as const,
    })),
    {
      id: "managed",
      path: join(config.dataDir, "attachments", "blobs"),
      kind: "managed" as const,
    },
  ];
  const rootById = (id: string) => {
    const root = roots().find((candidate) => candidate.id === id);
    if (!root) throw unavailable(404, "Attachment root not found");
    return root;
  };

  app.get("/api/attachments/roots", () =>
    roots().map((root) => ({
      id: root.id,
      kind: root.kind,
      path: root.kind === "managed" ? "Synapse application data" : root.path,
      access: root.kind === "managed" ? "copy" : "reference",
    })),
  );

  app.get("/api/attachments/browse", async (request) => {
    const query = z
      .object({
        root: z.string().min(1),
        path: z.string().optional().default(""),
      })
      .strict()
      .parse(request.query);
    const root = rootById(query.root);
    if (root.kind === "managed")
      throw unavailable(403, "Managed storage cannot be browsed");
    if (query.path) assertRelative(query.path);
    const base = await realpath(root.path);
    const directory = query.path ? join(base, query.path) : base;
    if (!within(base, directory))
      throw unavailable(403, "Path is outside this root");
    if ((await realpath(directory)) !== directory)
      throw unavailable(403, "Symlinks are excluded");
    const entries = await readdir(directory, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const relPath = query.path ? `${query.path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: relPath,
          kind: "directory" as const,
          size: null,
        });
      } else if (
        entry.isFile() &&
        attachmentExtensions.has(extname(entry.name).toLowerCase())
      ) {
        const file = await safeFile(base, relPath);
        try {
          items.push({
            name: entry.name,
            path: relPath,
            kind: "file" as const,
            size: (await file.stat()).size,
          });
        } finally {
          await file.close();
        }
      }
    }
    items.sort(
      (left, right) =>
        Number(right.kind === "directory") -
          Number(left.kind === "directory") ||
        left.name.localeCompare(right.name),
    );
    return {
      root: root.id,
      path: query.path,
      parent: query.path ? query.path.split("/").slice(0, -1).join("/") : null,
      items,
    };
  });

  app.get("/api/attachments", async (request) => {
    const query = z
      .object({ owner: z.string().optional() })
      .strict()
      .parse(request.query);
    const ownerNid = query.owner ? nid(query.owner) : undefined;
    const rows = state.db
      .prepare(
        `SELECT ${attachmentFields} FROM attachment ${ownerNid ? "WHERE owner_nid=?" : ""} ORDER BY display_name COLLATE NOCASE`,
      )
      .all(...(ownerNid ? [ownerNid] : [])) as Record<string, unknown>[];
    return Promise.all(
      rows.map(async (row) => {
        let availability = row.availability;
        if (row.mode === "reference") {
          try {
            const root = rootById(String(row.root_id));
            if (root.kind === "managed")
              throw unavailable(
                404,
                "Managed attachment content is unavailable",
              );
            const file = await safeFile(root.path, String(row.rel_path));
            await file.close();
            availability = "ok";
          } catch {
            availability = "missing";
          }
          if (availability !== row.availability) {
            state.db
              .prepare(
                "UPDATE attachment SET availability=?,last_verified_at=? WHERE id=?",
              )
              .run(String(availability), Date.now(), String(row.id));
          }
        } else if (row.mode === "managed") {
          try {
            const blob = state.db
              .prepare("SELECT stored_rel FROM attachment_blob WHERE sha256=?")
              .get(String(row.blob_sha256)) as
              { stored_rel: string } | undefined;
            if (!blob) throw unavailable(404, "Managed blob is missing");
            const file = await safeFile(config.dataDir, blob.stored_rel);
            await file.close();
            availability = "ok";
          } catch {
            availability = "missing";
          }
          if (availability !== row.availability) {
            state.db
              .prepare(
                "UPDATE attachment SET availability=?,last_verified_at=? WHERE id=?",
              )
              .run(String(availability), Date.now(), String(row.id));
          }
        }
        return { ...row, availability };
      }),
    );
  });

  app.post("/api/attachments", async (request) => {
    const body = z
      .object({
        owner: z.string().min(1),
        mode: z.literal("reference"),
        rootId: z.string().min(1),
        relPath: z.string().min(1),
        note: z.string().max(2000).optional(),
      })
      .strict()
      .parse(request.body);
    const owner = topic(body.owner);
    const root = rootById(body.rootId);
    if (root.kind === "managed")
      throw unavailable(422, "Managed copies are not available yet");
    assertRelative(body.relPath);
    const file = await safeFile(root.path, body.relPath);
    let size: number;
    try {
      size = (await file.stat()).size;
    } finally {
      await file.close();
    }
    const name = basename(body.relPath);
    const ext = extname(name).toLowerCase();
    if (!attachmentExtensions.has(ext))
      throw unavailable(422, "This file type is not approved as an attachment");
    const id = randomUUID();
    const existing = state.db
      .prepare(
        "SELECT id FROM attachment WHERE owner_nid=? AND root_id=? AND rel_path=? AND mode='reference'",
      )
      .get(nid(owner.slug), root.id, body.relPath);
    if (existing)
      throw unavailable(409, "This file is already attached to this item");
    try {
      state.db
        .prepare(
          `INSERT INTO attachment(id,owner_nid,mode,root_id,rel_path,display_name,original_name,file_kind,mime,size,availability,last_verified_at,created_at,note)
        VALUES(?,?,'reference',?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          nid(owner.slug),
          root.id,
          body.relPath,
          name,
          name,
          ext.slice(1) || "file",
          ext === ".pdf"
            ? "application/pdf"
            : ext === ".ipynb"
              ? "application/json"
              : null,
          size,
          "ok",
          Date.now(),
          Date.now(),
          body.note ?? null,
        );
    } catch (cause) {
      if ((cause as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        throw unavailable(409, "This file is already attached to this item");
      throw cause;
    }
    return state.db
      .prepare(`SELECT ${attachmentFields} FROM attachment WHERE id=?`)
      .get(id);
  });

  app.post(
    "/api/attachments/upload",
    { bodyLimit: config.attachments.maxUploadBytes + 64 * 1024 },
    async (request) => {
      const { owner: ownerSlug } = z
        .object({ owner: z.string().min(1) })
        .strict()
        .parse(request.query);
      const owner = topic(ownerSlug);
      const upload = await request.file();
      if (!upload) throw unavailable(422, "Choose a file to import");
      const name = Array.from(basename(upload.filename.replaceAll("\\", "/")))
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        })
        .join("")
        .trim();
      const ext = extname(name).toLowerCase();
      if (!name || !attachmentExtensions.has(ext)) {
        upload.file.resume();
        throw unavailable(
          422,
          "This file type is not approved as an attachment",
        );
      }
      const now = Date.now();
      const attachmentRoot = join(config.dataDir, "attachments");
      const tempDirectory = join(attachmentRoot, "tmp");
      const blobRoot = join(attachmentRoot, "blobs");
      await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
      await mkdir(blobRoot, { recursive: true, mode: 0o700 });
      if (
        (await realpath(tempDirectory)) !== tempDirectory ||
        (await realpath(blobRoot)) !== blobRoot
      )
        throw unavailable(
          403,
          "Symlinks in managed attachment storage are unsupported",
        );
      const tempPath = join(tempDirectory, randomUUID());
      const hasher = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > config.attachments.maxUploadBytes) {
            callback(
              unavailable(
                413,
                "The selected file exceeds the configured size limit",
              ),
            );
            return;
          }
          hasher.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          upload.file,
          meter,
          createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
        );
        if (upload.file.truncated)
          throw unavailable(
            413,
            "The selected file exceeds the configured size limit",
          );
        const sha256 = hasher.digest("hex");
        const ownerNid = nid(owner.slug);
        if (
          state.db
            .prepare(
              "SELECT id FROM attachment WHERE owner_nid=? AND mode='managed' AND blob_sha256=?",
            )
            .get(ownerNid, sha256)
        )
          throw unavailable(409, "This copy is already attached to this item");
        const storedRel = join(
          "attachments",
          "blobs",
          sha256.slice(0, 2),
          sha256.slice(2, 4),
          sha256,
        );
        const blobPath = join(config.dataDir, storedRel);
        await mkdir(join(blobPath, ".."), { recursive: true, mode: 0o700 });
        if ((await realpath(join(blobPath, ".."))) !== join(blobPath, ".."))
          throw unavailable(
            403,
            "Symlinks in managed attachment storage are unsupported",
          );
        let createdBlob = false;
        try {
          await link(tempPath, blobPath);
          createdBlob = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          const current = await lstat(blobPath);
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.size !== size
          )
            throw unavailable(409, "A conflicting managed blob already exists");
          const existingHash = createHash("sha256");
          for await (const chunk of createReadStream(blobPath))
            existingHash.update(chunk);
          if (existingHash.digest("hex") !== sha256)
            throw unavailable(409, "A conflicting managed blob already exists");
        }
        await unlink(tempPath);
        try {
          transaction(state.db, () => {
            state.db
              .prepare(
                `INSERT INTO attachment_blob(sha256,size,mime,stored_rel,created_at,trashed_at)
               VALUES(?,?,?,?,?,NULL) ON CONFLICT(sha256) DO UPDATE SET trashed_at=NULL`,
              )
              .run(sha256, size, upload.mimetype, storedRel, now);
            state.db
              .prepare(
                `INSERT INTO attachment(id,owner_nid,mode,blob_sha256,display_name,original_name,file_kind,mime,size,sha256,availability,last_verified_at,created_at)
               VALUES(?,?,'managed',?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                randomUUID(),
                ownerNid,
                sha256,
                name,
                name,
                ext.slice(1),
                upload.mimetype,
                size,
                sha256,
                "ok",
                now,
                now,
              );
          });
        } catch (cause) {
          if (
            createdBlob &&
            !state.db
              .prepare("SELECT sha256 FROM attachment_blob WHERE sha256=?")
              .get(sha256)
          )
            await unlink(blobPath).catch(() => undefined);
          if ((cause as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
            throw unavailable(
              409,
              "This copy is already attached to this item",
            );
          throw cause;
        }
        return state.db
          .prepare(
            `SELECT ${attachmentFields} FROM attachment WHERE owner_nid=? AND mode='managed' AND blob_sha256=?`,
          )
          .get(ownerNid, sha256);
      } catch (cause) {
        await unlink(tempPath).catch(() => undefined);
        if (upload.file.truncated)
          throw unavailable(
            413,
            "The selected file exceeds the configured size limit",
          );
        throw cause;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/attachments/:id/content",
    async (request, reply) => {
      const row = state.db
        .prepare(`SELECT ${attachmentFields} FROM attachment WHERE id=?`)
        .get(request.params.id) as Record<string, unknown> | undefined;
      if (!row) throw unavailable(404, "Attachment not found");
      if (row.mode === "managed") {
        const blob = state.db
          .prepare("SELECT stored_rel FROM attachment_blob WHERE sha256=?")
          .get(String(row.blob_sha256)) as { stored_rel: string } | undefined;
        if (!blob)
          throw unavailable(404, "Managed attachment content is unavailable");
        return serveContent(
          config.dataDir,
          blob.stored_rel,
          String(row.display_name),
          request,
          reply,
        );
      }
      const root = rootById(String(row.root_id));
      return serveContent(
        root.path,
        String(row.rel_path),
        String(row.display_name),
        request,
        reply,
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/attachments/:id",
    async (request, reply: FastifyReply) => {
      const attachment = state.db
        .prepare("SELECT mode,blob_sha256 FROM attachment WHERE id=?")
        .get(request.params.id) as
        { mode: string; blob_sha256: string | null } | undefined;
      if (!attachment) throw unavailable(404, "Attachment not found");
      if (attachment.mode === "managed") {
        transaction(state.db, () => {
          state.db
            .prepare("DELETE FROM attachment WHERE id=?")
            .run(request.params.id);
          const count = state.db
            .prepare(
              "SELECT count(*) AS count FROM attachment WHERE blob_sha256=?",
            )
            .get(attachment.blob_sha256) as { count: number };
          if (count.count === 0)
            state.db
              .prepare("UPDATE attachment_blob SET trashed_at=? WHERE sha256=?")
              .run(Date.now(), attachment.blob_sha256);
        });
        return reply.code(204).send();
      }
      const result = state.db
        .prepare("DELETE FROM attachment WHERE id=? AND mode='reference'")
        .run(request.params.id);
      if (!result.changes)
        throw unavailable(404, "Reference attachment not found");
      return reply.code(204).send();
    },
  );
}

function within(root: string, target: string) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
}
