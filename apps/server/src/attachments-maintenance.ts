import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import type { Config } from "./config";
import type { State } from "./db/index";
import { transaction } from "./db/transaction";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
type Blob = {
  sha256: string;
  size: number;
  stored_rel: string;
  trashed_at: number | null;
  refs: number;
};

function relativePath(sha256: string, area: "blobs" | "trash") {
  return area === "blobs"
    ? join(
        "attachments",
        "blobs",
        sha256.slice(0, 2),
        sha256.slice(2, 4),
        sha256,
      )
    : join("attachments", "trash", sha256);
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function ensurePrivateDirectory(dataDir: string, path: string) {
  if (!within(dataDir, path))
    throw new Error(
      "Managed attachment directory escaped application storage.",
    );
  const parts = relative(dataDir, path).split(sep).filter(Boolean);
  let cursor = dataDir;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Symlinks in managed attachment storage are unsupported.",
      );
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function inspect(dataDir: string, path: string, blob: Blob) {
  const absolute = join(dataDir, path);
  if (!within(dataDir, absolute)) return false;
  try {
    let cursor = dataDir;
    const parts = relative(dataDir, absolute).split(sep);
    for (const [index, part] of parts.entries()) {
      cursor = join(cursor, part);
      const component = await lstat(cursor);
      if (
        component.isSymbolicLink() ||
        (index < parts.length - 1 && !component.isDirectory())
      )
        return false;
    }
    const stat = await lstat(absolute);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== blob.size
    )
      return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    return hash.digest("hex") === blob.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reconciles managed blobs after interrupted operations and purges expired trash. */
export async function cleanupManagedAttachments(
  config: Pick<Config, "dataDir">,
  state: State,
  now = Date.now(),
) {
  const root = join(config.dataDir, "attachments");
  const trashRoot = join(root, "trash");
  await ensurePrivateDirectory(config.dataDir, root);
  await ensurePrivateDirectory(config.dataDir, join(root, "blobs"));
  await ensurePrivateDirectory(config.dataDir, trashRoot);
  const blobs = state.db
    .prepare(
      `SELECT b.sha256,b.size,b.stored_rel,b.trashed_at,
       (SELECT count(*) FROM attachment a WHERE a.blob_sha256=b.sha256) AS refs
     FROM attachment_blob b ORDER BY b.sha256`,
    )
    .all() as Blob[];

  for (const blob of blobs) {
    if (
      !/^[a-f0-9]{64}$/.test(blob.sha256) ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0
    )
      continue;
    const blobRel = relativePath(blob.sha256, "blobs");
    const trashRel = relativePath(blob.sha256, "trash");
    // Database paths are never trusted for filesystem access; only deterministic paths are used.
    const expected =
      blob.stored_rel === blobRel || blob.stored_rel === trashRel;
    if (!expected) continue;
    const blobValid = await inspect(config.dataDir, blobRel, blob);
    const trashValid = await inspect(config.dataDir, trashRel, blob);

    if (blob.refs > 0) {
      if (trashValid && !blobValid) {
        const blobPath = join(config.dataDir, blobRel);
        if (await exists(blobPath)) continue;
        await ensurePrivateDirectory(
          config.dataDir,
          join(root, "blobs", blob.sha256.slice(0, 2), blob.sha256.slice(2, 4)),
        );
        await rename(join(config.dataDir, trashRel), blobPath);
      } else if (trashValid && blobValid) {
        await unlink(join(config.dataDir, trashRel));
      } else if (!blobValid) {
        // Leave missing/corrupt data visible to the normal attachment availability checks.
        continue;
      }
      transaction(state.db, () => {
        state.db
          .prepare(
            "UPDATE attachment_blob SET stored_rel=?,trashed_at=NULL WHERE sha256=?",
          )
          .run(blobRel, blob.sha256);
      });
      continue;
    }

    if (blobValid && !trashValid) {
      await ensurePrivateDirectory(config.dataDir, trashRoot);
      await rename(
        join(config.dataDir, blobRel),
        join(config.dataDir, trashRel),
      );
      transaction(state.db, () => {
        state.db
          .prepare(
            "UPDATE attachment_blob SET stored_rel=?,trashed_at=coalesce(trashed_at,?) WHERE sha256=?",
          )
          .run(trashRel, now, blob.sha256);
      });
      continue;
    }
    if (blobValid && trashValid) {
      await unlink(join(config.dataDir, blobRel));
      transaction(state.db, () => {
        state.db
          .prepare(
            "UPDATE attachment_blob SET stored_rel=?,trashed_at=coalesce(trashed_at,?) WHERE sha256=?",
          )
          .run(trashRel, now, blob.sha256);
      });
      continue;
    }
    if (!blob.trashed_at || now - blob.trashed_at < retentionMs) continue;
    if (trashValid) await unlink(join(config.dataDir, trashRel));
    transaction(state.db, () => {
      state.db
        .prepare(
          "DELETE FROM attachment_blob WHERE sha256=? AND trashed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachment WHERE blob_sha256=?)",
        )
        .run(blob.sha256, blob.sha256);
    });
  }
}
