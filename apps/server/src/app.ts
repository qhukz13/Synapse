import { registerChangesets } from "./routes/changesets";
import { registerEditor } from "./routes/editor";
import { registerNotes } from "./routes/notes";
import { registerPractice } from "./routes/practice";
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
import { SessionService } from "./sessions";
import { recommendTopics } from "@synapse/core/recommendations";
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
  const sessions = new SessionService(state.db, config);
  writer.recover();
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
  const ctx = { app, config, state, work, topic, nid, sessions };
  registerRead(ctx, writer);
  registerEditor(ctx, writer);
  registerNotes(ctx, writer);
  registerPractice(ctx);
  registerChangesets(ctx, writer);
  registerSessions(ctx);
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
    sessions.close();
    state.close();
  });
  return ctx;
}
export type Context = {
  app: FastifyInstance;
  config: Config;
  state: ReturnType<typeof openState>;
  sessions: SessionService;
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
    vaultPath: config.vaultPath,
    personalNotesRoot: config.personalNotes.root,
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
    const checkboxHash =
      note.status.source === "course-checkbox"
        ? (work.scan.files.find(
            (source) => source.path === config.courseHomeNote,
          )?.hash ?? null)
        : note.exercises.some((item) => item.offset !== null)
          ? file.hash
          : null;
    return { ...note, body: file.text.slice(note.fm.bodyStart), checkboxHash };
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
  app.get("/api/recommendations", () => {
    const lastActivity: Record<string, number> = Object.create(null);
    for (const node of work.index.nodes) lastActivity[node.slug] = node.mtimeMs;
    const recentSessions = state.db
      .prepare(
        `SELECT ni.slug,MAX(ss.started_at) AS at
      FROM study_session ss JOIN node_identity ni ON ni.nid=ss.nid
      WHERE ss.state!='discarded' AND ss.started_at>=? GROUP BY ni.slug`,
      )
      .all(Date.now() - 14 * 86400_000) as { slug: string; at: number }[];
    for (const row of recentSessions)
      lastActivity[row.slug] = Math.max(lastActivity[row.slug] ?? 0, row.at);
    const statusActivity = state.db
      .prepare(
        `SELECT ni.slug,MAX(se.at) AS at
      FROM status_event se JOIN node_identity ni ON ni.nid=se.nid GROUP BY ni.slug`,
      )
      .all() as { slug: string; at: number }[];
    for (const row of statusActivity)
      lastActivity[row.slug] = Math.max(lastActivity[row.slug] ?? 0, row.at);
    const dependents: Record<string, number> = Object.create(null);
    for (const edge of work.index.edges)
      dependents[edge.to] = (dependents[edge.to] ?? 0) + 1;
    return recommendTopics(
      work.index.nodes.map((node) => ({
        slug: node.slug,
        title: node.title,
        kind: node.kind,
        stage: node.stage,
        domain: node.domain,
        track: String(node.position?.track ?? node.fm.meta.track ?? "core"),
        importance: String(node.fm.meta.importance ?? ""),
        difficulty: String(node.fm.meta.difficulty ?? ""),
        category: node.status.category,
        order: node.position?.index ?? null,
        introMoc:
          node.position !== null ||
          work.index.edges.some((edge) => edge.to === node.slug),
      })),
      work.index.prerequisites,
      lastActivity,
      dependents,
      new Set(recentSessions.map((row) => row.slug)),
    );
  });
  app.get("/api/activity", () =>
    state.db
      .prepare(
        `SELECT at,kind,title,slug FROM (
    SELECT se.at AS at,'status' AS kind,ni.title || ' · ' || se.to_status AS title,ni.slug AS slug
      FROM status_event se JOIN node_identity ni ON ni.nid=se.nid
    UNION ALL
    SELECT ss.started_at AS at,'session' AS kind,COALESCE(ni.title,'General study') AS title,ni.slug AS slug
      FROM study_session ss LEFT JOIN node_identity ni ON ni.nid=ss.nid WHERE ss.state!='discarded'
    UNION ALL
    SELECT cs.created_at AS at,'change-set' AS kind,cs.title AS title,NULL AS slug
      FROM change_set cs WHERE cs.state IN ('applied','partially-applied')
  ) ORDER BY at DESC LIMIT 8`,
      )
      .all(),
  );
  app.get("/api/library", () => work.scan.library);
  app.get("/api/resources", () => {
    const resources = new Map<
      string,
      {
        url: string;
        title: string;
        kind: string;
        id: string;
        owners: string[];
        doneAt: number | null;
      }
    >();
    for (const n of work.index.nodes)
      for (const r of n.resources) {
        const found = resources.get(r.id);
        if (found) {
          if (!found.owners.includes(n.slug)) found.owners.push(n.slug);
        } else
          resources.set(r.id, {
            url: r.url,
            title: r.title,
            kind: r.kind,
            id: r.id,
            owners: [n.slug],
            doneAt: null,
          });
      }
    for (const resource of resources.values()) {
      const resourceState = state.db
        .prepare("SELECT done_at FROM resource_state WHERE resource_id=?")
        .get(resource.id) as { done_at: number | null } | undefined;
      resource.doneAt = resourceState?.done_at ?? null;
    }
    return [...resources.values()];
  });
  app.post<{ Params: { id: string } }>("/api/resources/:id/state", (req) => {
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    const exists = work.index.nodes.some((node) =>
      node.resources.some((resource) => resource.id === req.params.id),
    );
    if (!exists) throw httpError(404, "Resource not found");
    state.db
      .prepare(
        `INSERT INTO resource_state(resource_id,done_at) VALUES(?,?)
      ON CONFLICT(resource_id) DO UPDATE SET done_at=excluded.done_at`,
      )
      .run(req.params.id, done ? Date.now() : null);
    return {
      id: req.params.id,
      done,
      doneAt: done
        ? (state.db
            .prepare("SELECT done_at FROM resource_state WHERE resource_id=?")
            .get(req.params.id)?.done_at ?? null)
        : null,
    };
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

function registerSessions({ app, nid, sessions, work }: Context) {
  app.get("/api/sessions/current", () => sessions.current());
  app.get("/api/sessions", () => sessions.list());
  app.get("/api/stats/study", () => {
    const stats = sessions.stats();
    const domainMs = new Map<string, number>();
    for (const [topicNid, ms] of Object.entries(stats.focusByNid)) {
      const topic = work.index.nodes.find(
        (node) => nid(node.slug) === topicNid,
      );
      const domain =
        topic?.domain || (topic ? "Unassigned domain" : "Unlinked topic");
      domainMs.set(domain, (domainMs.get(domain) ?? 0) + ms);
    }
    if (stats.generalMs)
      domainMs.set(
        "General study",
        (domainMs.get("General study") ?? 0) + stats.generalMs,
      );
    return {
      ...stats,
      focusByDomain: [...domainMs]
        .map(([domain, ms]) => ({ domain, ms }))
        .sort((a, b) => b.ms - a.ms || a.domain.localeCompare(b.domain)),
    };
  });
  app.post("/api/sessions", (req) => {
    const { topicSlug } = z
      .object({ topicSlug: z.string().optional() })
      .parse(req.body ?? {});
    return sessions.start(topicSlug ? nid(topicSlug) : null);
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/heartbeat", (req) => {
    const { lastInputAt } = z
      .object({ lastInputAt: z.number().int().nonnegative() })
      .parse(req.body);
    return sessions.heartbeat(req.params.id, lastInputAt);
  });
  app.post<{ Params: { id: string; action: string } }>(
    "/api/sessions/:id/:action",
    (req) => {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "stop", "discard"]) })
        .parse(req.params);
      const { note } = z
        .object({ note: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      return sessions.action(req.params.id, action, note);
    },
  );
  app.post<{ Params: { id: string; segmentId: string } }>(
    "/api/sessions/:id/restore-idle/:segmentId",
    (req) => {
      const segmentId = z.coerce
        .number()
        .int()
        .positive()
        .parse(req.params.segmentId);
      return sessions.restoreIdle(req.params.id, segmentId);
    },
  );
  app.post<{ Params: { id: string; segmentId: string } }>(
    "/api/sessions/:id/segments/:segmentId/trim",
    (req) => {
      const segmentId = z.coerce
        .number()
        .int()
        .positive()
        .parse(req.params.segmentId);
      const patch = z
        .object({
          startAt: z.number().int().optional(),
          endAt: z.number().int().optional(),
          delete: z.boolean().optional(),
          confirm: z.boolean().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.delete === true ||
            value.startAt !== undefined ||
            value.endAt !== undefined,
          "Choose a shorter interval or remove the segment.",
        )
        .parse(req.body);
      return sessions.trimSegment(req.params.id, segmentId, patch);
    },
  );
}
