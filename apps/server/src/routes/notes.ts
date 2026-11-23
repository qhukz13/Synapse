import { z } from "zod";
import { basename, dirname, posix } from "node:path";
import type { Context } from "../app";
import { WriteCoordinator, WriteError } from "../vault/writes";
import {
  addFrontmatter,
  setFrontmatterList,
  setFrontmatterScalar,
} from "../../../../packages/core/src/patch";
import { frontmatter } from "../../../../packages/core/src/parse/frontmatter";

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
      .map((note) => {
        const file = work.scan.files.find((entry) => entry.path === note.path);
        const snippet = file?.text
          .slice(note.fm.bodyStart)
          .split(/\r?\n/)
          .find((line) => line.trim() && !/^\s{0,3}#{1,6}\s/.test(line))
          ?.trim()
          .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
          .replace(/\s+/g, " ")
          .slice(0, 180);
        return {
          slug: note.slug,
          title: note.title,
          path: note.path,
          scope: String(note.fm.meta.scope ?? "legacy"),
          domain: note.domain,
          stage: note.stage,
          about: note.about,
          snippet: snippet ?? "No note preview available.",
          hash: note.hash,
          mtimeMs: note.mtimeMs,
        };
      });
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
        inbound: work.index.nodes
          .filter((source) =>
            source.links.some((link) => link.slug === note.slug),
          )
          .map((source) => ({ slug: source.slug, title: source.title })),
      };
    },
  );
  app.post("/api/personal-notes", async (request) => {
    const body = z
      .object({
        title: titleInput,
        scope: z.enum(["general", "topic", "project"]),
        aboutSlug: z.string().optional(),
        content: z.string().max(100_000).default(""),
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
      body.content.trim(),
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

  app.post<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug/append",
    async (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      const { baseHash, text } = z
        .object({ baseHash: hash, text: z.string().trim().min(1).max(100_000) })
        .strict()
        .parse(request.body);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const stamp = new Intl.DateTimeFormat("sv-SE", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date());
      const entry = `\n\n### ${stamp}\n\n${text.trim()}\n`;
      return writer.write({
        trigger: "note",
        path: note.path,
        baseHash,
        op: { type: "appendText", text: entry },
      });
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug/rename",
    async (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      if (!note.path.startsWith(config.personalNotes.root + "/"))
        throw new WriteError(
          403,
          "NOT_ALLOWED",
          "Move this legacy note into Personal Notes before renaming it.",
        );
      const body = z
        .object({
          baseHash: hash,
          title: titleInput,
          confirmInbound: z.boolean(),
        })
        .strict()
        .parse(request.body);
      const inbound = work.index.nodes
        .filter((source) =>
          source.links.some((link) => link.slug === note.slug),
        )
        .map((source) => ({ slug: source.slug, title: source.title }));
      if (inbound.length && !body.confirmInbound)
        throw new WriteError(
          409,
          "INBOUND_LINKS",
          "Renaming may break links from other notes. Confirm after reviewing them.",
          { inbound },
        );
      const title = body.title.replace(/\.md$/i, "").trim();
      const destination = posix.join(dirname(note.path), title + ".md");
      const file = work.scan.files.find((entry) => entry.path === note.path);
      if (!file)
        throw new WriteError(404, "NOT_FOUND", "Personal note unavailable.");
      const result = await writer.write({
        trigger: "note",
        path: note.path,
        baseHash: body.baseHash,
        op: { type: "moveFile", to: destination },
      });
      return {
        ...result,
        slug:
          work.index.nodes.find((item) => item.path === destination)?.slug ??
          null,
        inbound,
      };
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug/move",
    async (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      const body = z
        .object({
          baseHash: hash,
          scope: z.enum(["general", "topic", "project"]),
          aboutSlug: z.string().optional(),
        })
        .strict()
        .parse(request.body);
      let folder: string;
      let aboutTitle: string | null = null;
      if (body.scope === "general") {
        if (body.aboutSlug)
          throw new WriteError(
            422,
            "VALIDATION",
            "General notes have no owner.",
          );
        folder = `${config.personalNotes.root}/General`;
      } else {
        if (!body.aboutSlug)
          throw new WriteError(422, "VALIDATION", "Choose a topic or project.");
        const owner = topic(body.aboutSlug);
        const isProject = ["project", "course-project"].includes(owner.kind);
        if ((body.scope === "project") !== isProject)
          throw new WriteError(
            422,
            "VALIDATION",
            "The owner does not match this scope.",
          );
        aboutTitle = owner.title;
        folder = `${config.personalNotes.root}/${body.scope === "project" ? "Projects" : "Topics"}/${segment(owner.title)}`;
      }
      const file = work.scan.files.find((entry) => entry.path === note.path);
      if (!file)
        throw new WriteError(404, "NOT_FOUND", "Personal note unavailable.");
      let updated = file.text;
      try {
        const fm = frontmatter(updated);
        const associations = aboutTitle ? [`[[${aboutTitle}]]`] : [];
        if (!fm.present) {
          updated = addFrontmatter(updated, {
            type: "note",
            scope: body.scope,
            ...(associations.length ? { about: associations } : {}),
          });
        } else {
          updated = setFrontmatterScalar(updated, "scope", body.scope);
          updated = setFrontmatterList(updated, "about", associations);
        }
      } catch (cause) {
        throw new WriteError(
          422,
          "UNSUPPORTED_FRONTMATTER",
          cause instanceof Error
            ? cause.message
            : "This note's frontmatter cannot be updated safely.",
        );
      }
      const metadata = await writer.write({
        trigger: "note",
        path: note.path,
        baseHash: body.baseHash,
        op: { type: "replaceFile", text: updated },
      });
      const destination = posix.join(folder, basename(note.path));
      try {
        const moved = await writer.write({
          trigger: "note",
          path: note.path,
          baseHash: metadata.hash,
          op: { type: "moveFile", to: destination },
        });
        return {
          ...moved,
          slug:
            work.index.nodes.find((item) => item.path === destination)?.slug ??
            null,
        };
      } catch (cause) {
        try {
          await writer.write({
            trigger: "note",
            path: note.path,
            baseHash: metadata.hash,
            op: { type: "replaceFile", text: file.text },
          });
        } catch {
          throw new WriteError(
            409,
            "MOVE_RECOVERY_REQUIRED",
            "The note metadata was updated, but the move failed and an external change prevents automatic rollback. Review the note before continuing.",
            { path: note.path, destination },
          );
        }
        if (cause instanceof WriteError) throw cause;
        throw new WriteError(
          500,
          "MOVE_FAILED",
          "The note could not be moved.",
        );
      }
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/personal-notes/:slug/trash",
    async (request) => {
      const note = topic(request.params.slug);
      if (note.kind !== "note")
        throw new WriteError(404, "NOT_FOUND", "Personal note not found.");
      const { baseHash } = z
        .object({ baseHash: hash })
        .strict()
        .parse(request.body);
      return writer.write({
        trigger: "note",
        path: note.path,
        baseHash,
        op: { type: "trash" },
      });
    },
  );
}
