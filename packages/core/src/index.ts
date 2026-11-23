import { slugify } from "transliteration";
import { frontmatter } from "./parse/frontmatter";
import { fingerprint, structure } from "./parse/markdown";
import { parseCourseHome, parseLearningPath } from "./parse/paths";
import { resolveStatus } from "./status";
import { analyzeGraph } from "./graph";
export { vocabulary, confirmTransition } from "./status";
export type Source = {
  path: string;
  text: string;
  mtimeMs: number;
  hash: string;
};
export interface IndexOptions {
  library?: string[];
  conflicts?: string[];
  unsafe?: string[];
  learningPathNote?: string;
  courseHomeNote?: string;
  personalRoot?: string;
  exerciseSections?: string[];
}
type Severity = "error" | "warning" | "improvement" | "info";
export type Issue = {
  id: string;
  code: string;
  severity: Severity;
  path: string;
  message: string;
  why: string;
  line: number | null;
};
export const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
function infer(path: string, title: string, root: string) {
  if (
    path.startsWith(root + "/") ||
    / - notes$/i.test(title) ||
    /^99 - Inbox\/.+\/.+\.md$/i.test(path)
  )
    return "note";
  if (!path.includes("/Python Course/")) return "unknown";
  if (/^\d+ - /.test(title)) return "lesson";
  if (title === "Python Course Home") return "course";
  return title.startsWith("Project - ") ? "course-project" : "reference";
}
export function parseSource(file: Source, exerciseSections?: string[]) {
  const fm = frontmatter(file.text);
  return { fm, ...structure(file.text, fm.bodyStart, exerciseSections) };
}
export function buildIndex(
  files: Source[],
  options: IndexOptions = {},
  cache = new Map<string, ReturnType<typeof parseSource>>(),
) {
  const issues: Issue[] = [];
  function issue(
    code: string,
    severity: Severity,
    path: string,
    message: string,
    why: string,
    line: number | null = null,
  ) {
    issues.push({
      id: fingerprint(JSON.stringify([code, path, message, line])),
      code,
      severity,
      path,
      message,
      why,
      line,
    });
  }
  const pathFile = files.find(
    (f) =>
      f.path ===
      (options.learningPathNote ?? "00 - Start Here/Learning Path.md"),
  );
  const home = files.find(
    (f) =>
      f.path ===
      (options.courseHomeNote ??
        "01 - Foundations/Python Course/Python Course Home.md"),
  );
  const learningPath = parseLearningPath(pathFile?.text ?? "");
  const course = parseCourseHome(home?.text ?? "");
  for (const problem of learningPath.issues)
    issue(
      problem.code,
      "warning",
      pathFile?.path ?? "",
      problem.message,
      "The outline may need a manual edit.",
      problem.line,
    );
  const root = options.personalRoot ?? "Personal Notes";
  const used = new Set<string>();
  const nodes = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => {
      const title = f.path.split("/").at(-1)!.replace(/\.md$/i, "");
      const parseKey = JSON.stringify([f.hash, options.exerciseSections]);
      const parsed =
        cache.get(parseKey) ?? parseSource(f, options.exerciseSections);
      cache.set(parseKey, parsed);
      const { fm } = parsed,
        kind = String(fm.meta.type ?? infer(f.path, title, root));
      const base = slugify(title) || "note";
      let slug = base,
        i = 2;
      while (used.has(slug)) slug = base + "-" + i++;
      used.add(slug);
      const position = learningPath.positions.find(
        (x) => x.target.toLowerCase() === title.toLowerCase(),
      );
      const status = resolveStatus(
        kind,
        title,
        fm.meta.status,
        course.checkboxes,
      );
      if (fm.error)
        issue(
          "frontmatter.invalid",
          "error",
          f.path,
          fm.error,
          "Synapse cannot interpret this metadata reliably.",
          fm.line,
        );
      else if (!fm.present)
        issue(
          "frontmatter.missing",
          "improvement",
          f.path,
          "No frontmatter",
          "Metadata can describe the role of this file.",
        );
      if (status.unknown)
        issue(
          "status.unknown",
          "warning",
          f.path,
          "Unrecognized status: " + status.value,
          "Progress uses the original status vocabulary.",
        );
      for (const [field, values] of Object.entries({
        importance: ["low", "medium", "high"],
        difficulty: ["beginner", "intermediate", "advanced"],
      })) {
        if (
          typeof fm.meta[field] === "string" &&
          !values.includes(fm.meta[field])
        )
          issue(
            "field.unknownValue",
            "warning",
            f.path,
            "Unknown " + field + ": " + fm.meta[field],
            "This value is outside the curriculum vocabulary.",
          );
      }
      if (kind === "concept" && !/\*\*Primary\b/i.test(f.text))
        issue(
          "concept.noPrimaryResource",
          "info",
          f.path,
          "No primary resource marked",
          "Resources appear together until you mark a primary one.",
        );
      if (kind === "moc" && /^(00|13|99) -/.test(f.path))
        issue(
          "domain.catchAll",
          "info",
          f.path,
          "General index domain: " + fm.meta.domain,
          "Indexes may use broader domains than the material they contain.",
        );
      const mirror = course.checkboxes.find(
        (b) => b.targets.length === 1 && b.targets[0] === title,
      );
      if (
        kind === "lesson" &&
        status.source === "frontmatter" &&
        mirror &&
        mirror.checked !== (status.category === "completed")
      )
        issue(
          "lesson.checkboxMismatch",
          "warning",
          f.path,
          "Course checkbox differs from lesson status",
          "Frontmatter is authoritative after migration.",
        );
      return {
        ...parsed,
        path: f.path,
        title,
        slug,
        kind,
        stage: position?.stage ?? Number(/^(\d+) -/.exec(f.path)?.[1] ?? 0),
        folder: f.path.split("/").slice(0, -1).join("/"),
        domain: String(fm.meta.domain ?? ""),
        status,
        position: position ?? null,
        hash: f.hash,
        mtimeMs: f.mtimeMs,
        links: parsed.links.map((l) => ({ ...l, slug: null as string | null })),
        about: [] as string[],
      };
    });
  const byTitle = new Map<string, typeof nodes>();
  const folders = new Set<string>();
  for (const n of nodes) {
    const k = n.title.toLowerCase(),
      list = byTitle.get(k) ?? [];
    list.push(n);
    byTitle.set(k, list);
    for (const part of n.folder.split("/")) folders.add(part.toLowerCase());
  }
  function candidates(raw: string) {
    const key = raw
      .replace(/^\[\[|\]\]$/g, "")
      .replace(/\.md$/i, "")
      .toLowerCase();
    return key.includes("/")
      ? nodes
          .filter((n) =>
            ("/" + n.path.slice(0, -3).toLowerCase()).endsWith("/" + key),
          )
          .sort(
            (a, b) =>
              a.path.length - b.path.length || a.path.localeCompare(b.path),
          )
      : (byTitle.get(key) ?? []);
  }
  for (const list of byTitle.values())
    list.sort(
      (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path),
    );
  const edges: { from: string; to: string }[] = [],
    inbound = new Set<string>();
  const library = new Set(
    (options.library ?? []).flatMap((x) => [
      x.toLowerCase(),
      x.split("/").at(-1)!.toLowerCase(),
    ]),
  );
  for (const n of nodes) {
    for (const l of n.links) {
      const list = candidates(l.target),
        match = list[0];
      if (match) {
        l.slug = match.slug;
        inbound.add(match.slug);
        if (list.length > 1)
          issue(
            "link.ambiguous",
            "warning",
            n.path,
            "Several notes match " + l.target,
            "Use a folder-qualified link to disambiguate.",
            l.line,
          );
      } else if (!library.has(l.target.toLowerCase())) {
        const folder = folders.has(l.target.toLowerCase());
        issue(
          folder ? "link.folder" : "link.broken",
          "error",
          n.path,
          (folder ? "Folder link: " : "Missing target: ") + l.target,
          "This link has no matching note.",
          l.line,
        );
      }
    }
    const prereqs = strings(n.fm.meta.prerequisites);
    for (const p of prereqs) {
      const list = candidates(p);
      if (!list.length)
        issue(
          "prereq.missing",
          "error",
          n.path,
          "Missing prerequisite: " + p,
          "This dependency cannot be resolved.",
        );
      if (list.length > 1)
        issue(
          "prereq.ambiguous",
          "warning",
          n.path,
          "Ambiguous prerequisite: " + p,
          "Several notes share this name.",
        );
      edges.push({ from: n.slug, to: list[0]?.slug ?? "missing:" + p });
    }
    const bodyOnly = [
      ...new Set(
        n.links
          .filter(
            (l) =>
              l.section.toLowerCase() === "prerequisites" &&
              !prereqs.some((p) => p.toLowerCase() === l.target.toLowerCase()),
          )
          .map((l) => l.target),
      ),
    ];
    if (bodyOnly.length)
      issue(
        "prereq.bodyOnly",
        "warning",
        n.path,
        bodyOnly.join(", "),
        "These prerequisites appear in the text only. The graph reads frontmatter.",
      );
  }
  for (const n of nodes) {
    if (!inbound.has(n.slug))
      issue(
        "note.orphan",
        "info",
        n.path,
        "No incoming wiki-links",
        "Other notes do not link here.",
      );
    if (n.kind !== "note") continue;
    const declared = strings(n.fm.meta.about).flatMap((t) =>
      candidates(t)
        .slice(0, 1)
        .map((x) => x.slug),
    );
    const folder =
      n.folder.startsWith(root + "/Topics/") ||
      n.folder.startsWith(root + "/Projects/")
        ? candidates(n.folder.slice(root.length + 1).split("/")[1]!)[0]?.slug
        : null;
    const suffix = / - notes$/i.test(n.title)
      ? candidates(n.title.slice(0, -8))[0]?.slug
      : null;
    const callouts = nodes
      .filter((other) =>
        other.links.some((l) => l.slug === n.slug && l.personalCallout),
      )
      .map((x) => x.slug);
    n.about = [
      ...new Set(
        [...declared, folder, suffix, ...callouts].filter(
          (s): s is string => !!s,
        ),
      ),
    ];
    if (folder && declared.length && !declared.includes(folder))
      issue(
        "note.associationConflict",
        "warning",
        n.path,
        "Folder and about field disagree",
        "Both topic associations are displayed.",
      );
  }
  const graph = analyzeGraph(
    nodes.map((n) => ({
      slug: n.slug,
      category: n.status.category,
      order: n.position?.index ?? null,
    })),
    edges,
  );
  for (const e of graph.edges) {
    const n = nodes.find((n) => n.slug === e.from)!;
    if (e.laterInPath)
      issue(
        "prereq.laterInPath",
        "info",
        n.path,
        e.to,
        "This prerequisite comes later in the Learning Path.",
      );
    if (e.redundant)
      issue(
        "prereq.redundant",
        "info",
        n.path,
        e.to,
        "Another prerequisite already leads to this topic.",
      );
  }
  for (const group of graph.cycles)
    issue(
      "prereq.cycle",
      "warning",
      nodes.find((n) => n.slug === group[0])!.path,
      group.join(" → "),
      "Dependencies within a cycle are advisory.",
    );
  for (const p of options.conflicts ?? [])
    issue(
      "sync.conflictFile",
      "error",
      p,
      "Syncthing conflict copy",
      "Compare both versions before making changes.",
    );
  for (const p of options.unsafe ?? [])
    issue(
      "path.symlink",
      "warning",
      p,
      "Symlink excluded",
      "Linked files are outside the scanner’s file policy.",
    );
  return { nodes, issues, learningPath, course, ...graph };
}
export type VaultIndex = ReturnType<typeof buildIndex>;
export type Topic = VaultIndex["nodes"][number];
