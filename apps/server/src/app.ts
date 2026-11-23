import { registerEditor } from "./routes/editor";
import { WriteCoordinator, WriteError } from "./vault/writes";
import Fastify, { type FastifyInstance } from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { catalogue, topicRow } from "@synapse/core/view";
import { openState } from "./db/index";
import { projectDir, type Config } from "./config";
import { secure } from "./security";
import { Workspace } from "./vault/workspace";
import { serveContent } from "./vault/content";
import { safeFile, assertRelative } from "./vault/scanner";
export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
export async function createApp(config: Config, dev = false) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  secure(app, config, dev);
  const state = openState(config);
  let nids = new Map<string, string>();
  const work = new Workspace(config, (idx, files, origin) => {
    nids = state.reconcile(idx, files, origin);
  });
  const writer = new WriteCoordinator(config, state.db, (origin) =>
    work.refresh(origin),
  );
  if (config.allowVaultWrites) writer.recover();
  await work.start();
  const topic = (slug: string) => {
    const node = work.index.nodes.find((x) => x.slug === slug);
    if (!node) throw httpError(404, "Topic not found");
    return node;
  };
  const nid = (slug: string) => {
    topic(slug);
    return nids.get(slug)!;
  };
  const ctx = { app, config, state, work, topic, nid };
  registerRead(ctx, writer);
  registerEditor(ctx, writer);
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    work.subscribe(reply.raw, Number(req.headers["last-event-id"] ?? 0));
  });
  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string }, _req, rep) => {
      const status =
        err instanceof z.ZodError
          ? 422
          : (err.statusCode ?? (err.code === "ENOENT" ? 404 : 500));
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => i.path.join(".") + " " + i.message).join(", ")
          : status >= 500
            ? "The local operation failed. Check file access and application storage."
            : err.message;
      rep.code(status).send({
        message,
        code: err.code ?? (status === 409 ? "CONFLICT" : "VALIDATION"),
        ...(err instanceof WriteError && err.details
          ? { details: err.details }
          : {}),
      });
    },
  );
  const dist = join(projectDir, "apps/web/dist");
  if (existsSync(join(dist, "index.html"))) {
    await app.register(staticFiles, { root: dist });
    app.setNotFoundHandler((req, rep) =>
      req.method === "GET" &&
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/assets/")
        ? rep.sendFile("index.html")
        : rep.code(404).send({ message: "Not found" }),
    );
  }
  app.addHook("preClose", async () => {
    await work.close();
  });
  app.addHook("onClose", async () => {
    state.close();
  });
  return ctx;
}
export type Context = {
  app: FastifyInstance;
  config: Config;
  state: ReturnType<typeof openState>;
  work: Workspace;
  topic: (slug: string) => Workspace["index"]["nodes"][number];
  nid: (slug: string) => string;
};
function registerRead(
  { app, config, state, work, topic }: Context,
  writer: WriteCoordinator,
) {
  app.get("/api/health", () => ({
    ok: true,
    vaultAvailable: !work.unavailable,
    indexVersion: work.version,
  }));
  app.get("/api/index/summary", () => ({
    indexVersion: work.version,
    ...catalogue(work.index),
    unavailable: work.unavailable,
    writeEnabled: config.allowVaultWrites,
  }));
  app.get("/api/topics", (req) => {
    const filters = z.record(z.string(), z.string()).parse(req.query);
    return work.index.nodes
      .map(topicRow)
      .filter(
        (n) =>
          ["kind", "domain", "difficulty", "importance"].every(
            (k) => !filters[k] || n[k as "domain"] === filters[k],
          ) &&
          (!filters.status || n.status.value === filters.status) &&
          (!filters.source || n.status.source === filters.source) &&
          (!filters.prereqs ||
            (filters.prereqs === "met") ===
              ["met", "none"].includes(
                work.index.prerequisites[n.slug]!.summary,
              )),
      );
  });
  app.get<{ Params: { slug: string } }>("/api/topics/:slug", (req) => {
    const note = topic(req.params.slug);
    const file = work.scan.files.find((f) => f.path === note.path)!;
    return { ...note, body: file.text.slice(note.fm.bodyStart) };
  });
  app.get<{ Params: { slug: string } }>("/api/topics/:slug/source", (req) => {
    const n = topic(req.params.slug),
      file = work.scan.files.find((f) => f.path === n.path)!;
    return { text: file.text, hash: file.hash };
  });
  app.get("/api/graph", () => ({
    edges: work.index.edges,
    nodes: work.index.nodes.map(topicRow),
  }));
  app.get("/api/library", () => work.scan.library);
  app.get("/api/resources", () => {
    const resources = new Map<
      string,
      { url: string; title: string; kind: string; id: string; owners: string[] }
    >();
    for (const n of work.index.nodes)
      for (const r of n.resources) {
        const found = resources.get(r.url);
        if (found) {
          if (!found.owners.includes(n.slug)) found.owners.push(n.slug);
        } else
          resources.set(r.url, {
            url: r.url,
            title: r.title,
            kind: r.kind,
            id: r.id,
            owners: [n.slug],
          });
      }
    return [...resources.values()];
  });
  app.get<{ Params: { "*": string } }>("/api/files/*", (req, res) => {
    const p = req.params["*"];
    assertRelative(p);
    if (!work.scan.library.some((f) => f.path === p))
      throw httpError(404, "File unavailable");
    return serveContent(config.vaultPath, p, p, req, res);
  });
  app.get<{ Params: { "*": string } }>("/api/notebooks/*", async (req) => {
    const p = req.params["*"];
    assertRelative(p);
    if (
      !p.endsWith(".ipynb") ||
      !work.scan.library.some((f) => f.path === p && f.size <= 32 * 1024 * 1024)
    )
      throw httpError(404, "Notebook unavailable");
    const f = await safeFile(config.vaultPath, p);
    try {
      return JSON.parse(await f.readFile("utf8"));
    } finally {
      await f.close();
    }
  });
  app.get("/api/search", (req) => {
    const { q } = z
      .object({ q: z.string().max(300).default("") })
      .parse(req.query);
    if (!q.trim()) return [];
    const hits = state.search(q, 80);
    return hits.map((slug) => {
      const n = topic(slug),
        body = work.scan.files
          .find((f) => f.path === n.path)!
          .text.slice(n.fm.bodyStart),
        i = body.toLowerCase().indexOf(q.toLowerCase());
      return {
        ...topicRow(n),
        snippet: body.slice(Math.max(0, i - 32), Math.max(0, i) + 130),
      };
    });
  });
  app.get("/api/vault-health/issues", (req) => {
    const { severity } = z
      .object({ severity: z.string().optional() })
      .parse(req.query);
    const recovery = writer.recoveryIssues.map((issue, index) => ({
      id: "recovery-" + index,
      code: "write.unknownState",
      severity: "error",
      path: issue.path,
      line: null,
      message: issue.message,
      why: "Review the current file and its backup before editing.",
    }));
    return [...work.index.issues, ...recovery].filter(
      (issue) => !severity || issue.severity === severity,
    );
  });
  app.post("/api/admin/reindex", async () => {
    await work.refresh();
    return { indexVersion: work.version };
  });
}
