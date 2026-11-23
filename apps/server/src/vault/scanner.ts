import { constants } from "node:fs";
import { open, readdir, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename, extname, matchesGlob } from "node:path";
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const isIgnored = (part: string) =>
  part.startsWith(".") ||
  ["node_modules", "__pycache__"].includes(part) ||
  part.includes(".synapse-tmp-") ||
  part.startsWith("~syncthing~");
export function assertRelative(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32) ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((c) => !c || c === ".." || isIgnored(c))
  )
    throw Object.assign(Error("Path is outside the approved file tree"), {
      statusCode: 403,
    });
}
export async function safeFile(root: string, path: string) {
  assertRelative(path);
  const approved = await realpath(root);
  const target = join(approved, path);
  if ((await realpath(target)) !== target)
    throw Object.assign(Error("Symlinks are excluded"), { statusCode: 403 });
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (
      (await realpath("/proc/self/fd/" + file.fd)) !== target ||
      !(await file.stat()).isFile()
    )
      throw Object.assign(Error("File moved or unavailable"), {
        statusCode: 403,
      });
    return file;
  } catch (e) {
    await file.close();
    throw e;
  }
}
export const libraryExtensions = new Set(
  "pdf ipynb csv tsv png jpg jpeg gif webp svg py js ts json yaml yml toml txt sh sql c cpp rs go java r jl"
    .split(" ")
    .map((s) => "." + s),
);
export interface SourceFile {
  path: string;
  text: string;
  mtimeMs: number;
  hash: string;
}
export async function scanVault(root: string, ignore: string[] = []) {
  const files: SourceFile[] = [],
    library: { path: string; size: number; mtimeMs: number }[] = [],
    conflicts: string[] = [],
    unsafe: string[] = [];
  const base = await realpath(root);
  async function walk(prefix: string) {
    const dir = join(base, prefix);
    if ((await realpath(dir)) !== dir) {
      unsafe.push(prefix);
      return;
    }
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? prefix + "/" + e.name : e.name;
      if (
        isIgnored(e.name) ||
        ignore.some((pattern) => matchesGlob(path, pattern))
      )
        continue;
      if (e.isSymbolicLink()) {
        unsafe.push(path);
        continue;
      }
      if (e.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(path).toLowerCase();
      if (ext === ".md" && e.name.includes(".sync-conflict-")) {
        conflicts.push(path);
        continue;
      }
      if (ext === ".md") {
        const f = await safeFile(base, path);
        try {
          const bytes = await f.readFile();
          files.push({
            path,
            text: new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes),
            mtimeMs: (await f.stat()).mtimeMs,
            hash: hash(bytes),
          });
        } finally {
          await f.close();
        }
      } else if (libraryExtensions.has(ext)) {
        const st = await lstat(join(dir, basename(path)));
        library.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk("");
  return { files, library, conflicts, unsafe };
}
