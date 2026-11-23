import { extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { safeFile } from "./scanner";
export const mime: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ipynb": "application/json",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
};
export async function serveContent(
  root: string,
  path: string,
  name: string,
  req: FastifyRequest,
  res: FastifyReply,
) {
  const file = await safeFile(root, path);
  try {
    const size = (await file.stat()).size,
      ext = extname(name).toLowerCase();
    const type =
      mime[ext] ??
      (/\.(txt|md|py|tsx?|jsx?|sh|toml|ya?ml|sql|c|cpp|rs|go|java|r|jl)$/i.test(
        name,
      )
        ? "text/plain"
        : "application/octet-stream");
    res
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .type(type)
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "no-store");
    if (type === "application/octet-stream")
      res.header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(name.split("/").at(-1)!),
      );
    let start = 0,
      end = size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1]
          ? Number(match[1])
          : Math.max(0, size - Number(match[2]));
        end =
          match[1] && match[2]
            ? Math.min(size - 1, Number(match[2]))
            : size - 1;
      }
      if (
        !match ||
        !(match[1] || match[2]) ||
        start > end ||
        !Number.isSafeInteger(start) ||
        start < 0
      ) {
        await file.close();
        return res
          .code(416)
          .header("Content-Range", "bytes */" + size)
          .send();
      }
      res.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.header("Content-Length", Math.max(0, end - start + 1));
    if (!size || req.method === "HEAD") {
      await file.close();
      return res.send();
    }
    return res.send(file.createReadStream({ start, end, autoClose: true }));
  } catch (e) {
    await file.close();
    throw e;
  }
}
