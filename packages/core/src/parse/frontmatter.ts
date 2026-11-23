import { parseDocument } from "yaml";
import { z } from "zod";

const fields = {
  domain: z.string(),
  status: z.string(),
  difficulty: z.string(),
  importance: z.string(),
  prerequisites: z.array(z.string()),
};
const concept = z
  .object({ type: z.literal("concept"), ...fields })
  .passthrough();
const moc = z
  .object({
    type: z.literal("moc"),
    domain: fields.domain,
    status: fields.status,
  })
  .passthrough();
const lesson = moc.extend({ type: z.literal("lesson") });
const project = moc.extend({
  type: z.literal("project"),
  difficulty: fields.difficulty.optional(),
  builds: z.array(z.string()).optional(),
});
const resource = moc.extend({
  type: z.literal("resource"),
  difficulty: fields.difficulty,
  resource_type: z.string(),
  quality: z.string(),
  teaches: z.array(z.string()),
  source: z.string(),
});
const note = z
  .object({
    type: z.literal("note"),
    scope: z.enum(["topic", "project", "general"]).optional(),
    about: z.array(z.string()).optional(),
    created: z.string().optional(),
    prerequisites: fields.prerequisites.optional(),
  })
  .passthrough();
const schema = z.discriminatedUnion("type", [
  concept,
  moc,
  lesson,
  project,
  resource,
  note,
]);

export function frontmatter(text: string) {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const start = /^---[ \t]*\r?\n/.exec(text.slice(bom));
  const base = {
    present: false,
    meta: {} as Record<string, unknown>,
    bodyStart: bom,
    error: "",
    line: 0,
  };
  if (!start) return base;
  const offset = bom + start[0].length;
  const end = /^---[ \t]*(?:\r?\n|$)/m.exec(text.slice(offset));
  if (!end) return { ...base, error: "Unterminated frontmatter", line: 1 };
  const bodyStart = offset + end.index + end[0].length;
  const doc = parseDocument(text.slice(offset, offset + end.index), {
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  try {
    if (doc.errors[0])
      return {
        ...base,
        present: true,
        bodyStart,
        error: doc.errors[0].message.split("\n")[0]!,
        line: (doc.errors[0].linePos?.[0]?.line ?? 1) + 1,
      };
    const meta: unknown = doc.toJS({ maxAliasCount: 64 });
    const result = schema.safeParse(meta);
    if (!result.success)
      return {
        ...base,
        present: true,
        bodyStart,
        meta: z.record(z.string(), z.unknown()).safeParse(meta).data ?? {},
        error: result.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join(", "),
        line: 2,
      };
    return { ...base, present: true, bodyStart, meta: result.data };
  } catch {
    return {
      ...base,
      present: true,
      bodyStart,
      error: "Unsupported YAML structure",
      line: 2,
    };
  }
}
