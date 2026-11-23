import type { FastifyInstance } from "fastify";
import type { Config } from "./config";
export function secure(app: FastifyInstance, c: Config, dev: boolean) {
  const hosts = new Set(
    ["localhost", "127.0.0.1", "[::1]"].map((h) => h + ":" + c.server.port),
  );
  const origins = new Set([...hosts].map((h) => "http://" + h));
  if (dev) origins.add("http://127.0.0.1:5173");
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; font-src 'self' data:; frame-src 'self' https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:",
    });
    if (!hosts.has(req.headers.host ?? ""))
      return reply.code(421).send({ message: "Unrecognized local host" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.headers["x-synapse"] !== "1" ||
        !origins.has(req.headers.origin ?? "") ||
        !/^application\/json(?:;|$)|^multipart\/form-data;/i.test(
          req.headers["content-type"] ?? "",
        )
      )
        return reply
          .code(403)
          .send({
            message: "Local origin and Synapse mutation header required",
          });
    }
  });
}
