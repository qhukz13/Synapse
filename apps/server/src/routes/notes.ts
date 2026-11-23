import { z } from "zod";
import type { Context } from "../app";
import { WriteCoordinator, WriteError } from "../vault/writes";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const titleInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !/[\\/]/.test(value) &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) &&
      ![".", ".."].includes(value.replace(/\.md$/i, "")),
    "Use a note title without path separators or control characters.",
  );
const segment = (value: string) => {
  const safe = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === "/" ||
        character === "\\" ||
        code < 32 ||
        code === 127
        ? " - "
        : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!safe || safe === "." || safe === "..")
    throw new WriteError(422, "VALIDATION", "This note location is invalid.");
  return safe;
};

export function registerNotes(ctx: Context, writer: WriteCoordinator) {
  const { app, config, state, topic, work } = ctx;
  app.get("/api/personal-notes", (request) => {
    const { q, scope, aboutSlug, domain, stage } = z
      .object({
        q: z.string().max(300).default(""),
        scope: z.enum(["general", "topic", "project", "legacy"]).optional(),
        aboutSlug: z.string().max(160).optional(),
        domain: z.string().max(100).optional(),
        stage: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    const matches = q.trim() ? new Set(state.search(q, 200)) : null;
    return work.index.nodes
      .filter((note) => {
        if (note.kind !== "note") return false;
        const value = String(note.fm.meta.scope ?? "legacy");
        return (
          (!scope || value === scope) &&
          (!aboutSlug || note.about.includes(aboutSlug)) &&
          (!domain || note.domain === domain) &&
          (stage === undefined || note.stage === stage) &&
          (!matches || matches.has(note.slug))
        );
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title))
      .map((note) => ({
        slug: note.slug,
        title: note.title,
        path: note.path,
        scope: String(note.fm.meta.scope ?? "legacy"),
        domain: note.domain,
        stage: note.stage,
        about: note.about,
        hash: note.hash,
        mtimeMs: note.mtimeMs,
      }));
  });
  app.get<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug",
    (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      const file = work.scan.files.find((entry) => entry.path === note.path);
      if (!file)
        throw new WriteError(404, "NOT_FOUND", "Personal note unavailable.");
      return {
        slug: note.slug,
        title: note.title,
        path: note.path,
        scope: String(note.fm.meta.scope ?? "legacy"),
        about: note.about,
        hash: note.hash,
        text: file.text,
      };
    },
  );
  app.post("/api/personal-notes", async (request) => {
    const body = z
      .object({
        title: titleInput,
        scope: z.enum(["general", "topic", "project"]),
        aboutSlug: z.string().optional(),
      })
      .strict()
      .parse(request.body);
    const title = body.title.replace(/\.md$/i, "").trim();
    if (!title || title === "." || title === "..")
      throw new WriteError(422, "VALIDATION", "Enter a valid note title.");
    let folder: string;
    let aboutTitle: string | null = null;
    if (body.scope === "general") {
      if (body.aboutSlug)
        throw new WriteError(
          422,
          "VALIDATION",
          "General notes have no topic link.",
        );
      folder = `${config.personalNotes.root}/General`;
    } else {
      if (!body.aboutSlug)
        throw new WriteError(
          422,
          "VALIDATION",
          "Choose a topic or project for this note.",
        );
      const owner = topic(body.aboutSlug);
      const isProject = ["project", "course-project"].includes(owner.kind);
      if ((body.scope === "project") !== isProject)
        throw new WriteError(
          422,
          "VALIDATION",
          "The selected item does not match this note scope.",
        );
      aboutTitle = owner.title;
      folder = `${config.personalNotes.root}/${body.scope === "project" ? "Projects" : "Topics"}/${segment(owner.title)}`;
    }
    const path = `${folder}/${title}.md`;
    const frontmatter = [
      "---",
      "type: note",
      `scope: ${body.scope}`,
      ...(aboutTitle
        ? [`about:\n  - ${JSON.stringify(`[[${aboutTitle}]]`)}`]
        : []),
      `created: ${new Date().toISOString().slice(0, 10)}`,
      "---",
      `# ${title}`,
      "",
      "",
    ].join("\n");
    const result = await writer.write({
      trigger: "note",
      path,
      baseHash: null,
      op: { type: "createFile", text: frontmatter },
    });
    return {
      ...result,
      slug: work.index.nodes.find((note) => note.path === path)?.slug ?? null,
    };
  });
  app.put<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug",
    async (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      const body = z
        .object({ baseHash: hash, text: z.string().max(8 * 1024 * 1024) })
        .strict()
        .parse(request.body);
      return writer.write({
        trigger: "note",
        path: note.path,
        baseHash: body.baseHash,
        op: { type: "replaceFile", text: body.text },
      });
    },
  );
}
