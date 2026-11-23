import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildIndex, parseSource, type Source } from "../src/index";
import { frontmatter } from "../src/parse/frontmatter";
import { fingerprint, structure } from "../src/parse/markdown";
import { resourceInfo } from "../src/parse/resources";
import { matchExercises } from "../src/parse/exercise-match";
import { confirmTransition, resolveStatus, vocabulary } from "../src/status";

const source = (path: string, text: string): Source => ({
  path,
  text,
  mtimeMs: 1,
  hash: fingerprint(text),
});
const topic = (
  path: string,
  status = "unread",
  body = "",
  prerequisites = "[]",
) =>
  source(
    path,
    [
      "---",
      "type: concept",
      "domain: mathematics",
      "difficulty: beginner",
      "importance: high",
      "status: " + status,
      "prerequisites: " + prerequisites,
      "---",
      body,
    ].join("\n"),
  );

describe("document metadata", () => {
  it("reads source boundaries without altering BOM, formatting, or unknown fields", () => {
    const text =
      '\uFEFF---\r\ntype: project # comment\r\nstatus: "in-progress"\r\ndomain: signals\r\nextra: [a, b]\r\n---\r\n# Body\r\n';
    const result = frontmatter(text);
    expect(result).toMatchObject({
      present: true,
      error: "",
      meta: { status: "in-progress", extra: ["a", "b"] },
    });
    expect(text.slice(result.bodyStart)).toBe("# Body\r\n");
  });

  it("preserves malformed files for the reader and reports an accurate YAML error line", () => {
    expect(frontmatter("").present).toBe(false);
    expect(frontmatter("---\ntype: note")).toMatchObject({
      present: false,
      line: 1,
      error: "Unterminated frontmatter",
    });
    const duplicate = frontmatter(
      "---\ntype: note\nscope: general\nscope: topic\n---\n# Still visible",
    );
    expect(duplicate.error).toMatch(/unique/i);
    expect(duplicate.line).toBe(4);
    expect(frontmatter("---\ntype: concept\n---").error).toContain("domain");
    expect(frontmatter("---\n[]\n---").error).not.toBe("");
    expect(
      frontmatter(
        '---\ntype: note\nscope: project\nabout: ["[[A]]"]\ncreated: 2024-01-10\n---',
      ).error,
    ).toBe("");
    expect(
      frontmatter("---\ntype: lesson\ndomain: practice\nstatus: learning\n---")
        .error,
    ).toBe("");
  });
});

describe("Markdown structure", () => {
  it("extracts accurate offsets, roles, headings and reading data across YAML, math and code", () => {
    const raw = topic(
      "in/A.md",
      "learning",
      [
        "# 🔊 Signals",
        "## Resources",
        "**Primary**",
        "[Reader](https://example.org/reader)",
        "**Supplementary**",
        "[Series](https://example.org/series)",
        "## Intuition",
        "Follow [[Pulse#First|this note]] and `[[Ghost]]`. $x + [[Math]]$",
        "```text",
        "[[Hidden]]",
        "```",
        "## Steps",
        "1. Sum the samples",
        "2. Compare two sums",
        "## Checklist",
        "- [x] [[Pulse]]",
        "- [ ] Explain the result",
      ].join("\r\n"),
    );
    const parsed = parseSource(raw);
    expect(parsed.heading).toBe("Signals");
    expect(parsed.sections.map((s) => s.title)).toEqual([
      "Resources",
      "Intuition",
      "Steps",
      "Checklist",
    ]);
    expect(parsed.links.map((l) => l.target)).toEqual(["Pulse", "Pulse"]);
    for (const link of parsed.links) {
      expect(raw.text.slice(link.offset, link.offset + link.raw.length)).toBe(
        link.raw,
      );
      expect(raw.text.slice(0, link.offset).split("\n")).toHaveLength(
        link.line,
      );
    }
    expect(parsed.links[0]?.label).toBe("this note");
    expect(parsed.resources.map((r) => r.role)).toEqual([
      "primary",
      "supplementary",
    ]);
    expect(parsed.hasMath).toBe(true);
    expect(parsed.readingMinutes).toBeGreaterThan(0);
    expect(parsed.exercises.map((e) => e.ordinal)).toEqual([0, 1, 0, 1]);
    expect(
      parsed.exercises.map((e) =>
        e.offset === null ? null : raw.text[e.offset],
      ),
    ).toEqual([null, null, "x", " "]);
    expect(structure("", 0).readingMinutes).toBe(0);
  });

  it.each([
    ["https://youtu.be/test?t=1h2m3s", "youtube-video", 3723],
    [
      "https://www.youtube.com/watch?v=test&list=list&t=15s",
      "youtube-video-in-playlist",
      15,
    ],
    ["https://youtube.com/playlist?list=list", "youtube-playlist", 0],
    ["https://arxiv.org/pdf/a", "paper", 0],
    ["https://example.net/lesson.pdf", "pdf", 0],
    ["https://github.com/x/y", "repository", 0],
    ["https://kaggle.com/learn/abc", "course", 0],
    ["https://docs.python.org/abc", "docs", 0],
    ["https://d2l.ai/abc", "book", 0],
    ["https://kaggle.com/datasets/a", "practice", 0],
    ["http://example.org/a", "article", 0],
  ])("classifies %s", (url, kind, start) => {
    expect(resourceInfo(url as string)).toMatchObject({ kind, start });
  });
});

describe("status resolution", () => {
  it("chooses one authoritative source and preserves unexpected raw statuses", () => {
    const home = [
      { targets: ["Intro"], checked: true, offset: 5 },
      { targets: ["First", "Second"], checked: true, offset: 9 },
    ];
    expect(resolveStatus("lesson", "Intro", undefined, home)).toMatchObject({
      source: "course-checkbox",
      offset: 5,
      category: "completed",
    });
    expect(resolveStatus("lesson", "Intro", " unread ", home)).toMatchObject({
      source: "frontmatter",
      value: "unread",
      category: "not_started",
    });
    expect(
      resolveStatus("course-project", "First", undefined, home).reason,
    ).toBe("ambiguous-checkbox");
    expect(resolveStatus("lesson", "Other", undefined, home).reason).toBe(
      "not-in-course-home",
    );
    expect(resolveStatus("note", "First", undefined, home).reason).toBe(
      "no-frontmatter",
    );
    expect(resolveStatus("project", "First", "WIP", home)).toMatchObject({
      value: "WIP",
      unknown: true,
      category: "not_started",
    });
    expect(resolveStatus("project", "First", "Done", home).value).toBe(
      "completed",
    );
    expect(resolveStatus("project", "First", "in progress", home).value).toBe(
      "in-progress",
    );
    expect(resolveStatus("concept", "First", "in progress", home).value).toBe(
      "learning",
    );
    expect(
      resolveStatus("course-project", "Intro", undefined, [...home, home[0]!])
        .reason,
    ).toBe("ambiguous-checkbox");
  });

  it("checks every project transition against its explicit confirmation requirement", () => {
    const confirmed = new Set([
      "not-started/completed",
      "in-progress/not-started",
      "completed/not-started",
    ]);
    for (const from of vocabulary("project")) {
      for (const to of vocabulary("project"))
        expect(confirmTransition(from, to)).toBe(
          confirmed.has(from + "/" + to),
        );
    }
    expect(vocabulary("moc")).toContain("not-started");
    expect(vocabulary("course-project")).toEqual(vocabulary("project"));
  });
});

describe("stable exercise ticks", () => {
  const item = (text: string, ordinal: number, section = "Steps") => ({
    text,
    ordinal,
    section,
    fingerprint: fingerprint(text),
  });
  it("prioritizes exact matches after reordering, uses local similarity, and keeps removed ticks as orphans", () => {
    const old = [
      item("Measure the first sample", 0),
      item("Review the residual plot", 1),
      item("Compare both medians", 2),
      item("Discard the offset", 3),
    ];
    const fresh = [
      item("Compare both medians", 0),
      item("Review the final residual plot", 1),
      item("Measure the first sample", 2),
      item("Draw new predictions", 3),
    ];
    const matches = matchExercises(old, fresh);
    expect(matches.map((m) => m.reason)).toEqual([
      "unchanged",
      "reworded",
      "unchanged",
      "orphaned",
    ]);
    expect(matches.map((m) => m.current?.ordinal ?? null)).toEqual([
      2,
      1,
      0,
      null,
    ]);
    expect(matches[3]?.previous).toBe(old[3]);
  });

  it("reserves exact matches before fuzzy matches and confines the ordinal fallback to its old section", () => {
    const old = [
      item("Review the residual plot now", 0),
      item("Review the residual plot", 1),
    ];
    const fresh = [
      item("Review the residual plot", 0),
      item("Read the final residual plot", 0, "Stretch"),
    ];
    expect(matchExercises(old, fresh).map((m) => m.reason)).toEqual([
      "orphaned",
      "unchanged",
    ]);
  });
});

describe("curriculum index", () => {
  it("assigns reproducible slugs, resolves ambiguous basenames and validates broken structure", () => {
    const docs = [
      topic("Long/Section/Scale.md"),
      topic("A/Scale.md"),
      topic(
        "A/Пример.md",
        "WIP",
        "[[Scale]] [[A]] [[none]] [[file.pdf]]",
        "[Scale, Absent]",
      ),
      source("Unknown.md", "---\ntype: [\n---\n# Still readable"),
    ];
    const index = buildIndex(docs, {
      library: ["docs/file.pdf"],
      unsafe: ["escape"],
      conflicts: ["copy"],
    });
    const underTest = index.nodes.find((n) => n.title === "Пример")!;
    expect(underTest.slug).toBe("primer");
    expect(underTest.links[0]?.slug).toBe(
      index.nodes.find((n) => n.path === "A/Scale.md")?.slug,
    );
    expect(new Set(index.nodes.map((n) => n.slug)).size).toBe(docs.length);
    expect(index.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "status.unknown",
        "link.ambiguous",
        "prereq.ambiguous",
        "link.folder",
        "link.broken",
        "prereq.missing",
        "frontmatter.invalid",
        "sync.conflictFile",
        "path.symlink",
      ]),
    );
    expect(index.issues.some((i) => /tags/.test(i.code))).toBe(false);
    expect(index.nodes.find((n) => n.title === "Unknown")?.heading).toBe(
      "Still readable",
    );
  });

  it("derives personal-note associations from their exact source", () => {
    const docs = [
      topic(
        "Topic.md",
        "understood",
        "> [!note] Your notes\n> [[Notebook]]\n\n## References\n[[Separate]]",
      ),
      topic("Other.md"),
      source("Notebook.md", "---\ntype: note\n---\n# Notebook"),
      source("Separate.md", "---\ntype: note\n---\n# Separate"),
      source(
        "Personal Notes/Topics/Other/Extra.md",
        '---\ntype: note\nabout: ["[[Topic]]"]\n---',
      ),
      source("Old/Topic - notes.md", "# Legacy"),
    ];
    const index = buildIndex(docs);
    const about = (title: string) =>
      index.nodes.find((n) => n.title === title)!.about;
    expect(about("Notebook")).toEqual(["topic"]);
    expect(about("Separate")).toEqual([]);
    expect(about("Extra").sort()).toEqual(["other", "topic"]);
    expect(about("Topic - notes")).toEqual(["topic"]);
    expect(
      index.issues.filter((i) => i.code === "note.associationConflict"),
    ).toHaveLength(1);
  });

  it("honors changed exercise-section configuration when reusing parsed documents", () => {
    const docs = [topic("A.md", "unread", "## Custom\n1. Try the change")];
    const cache = new Map();
    expect(buildIndex(docs, {}, cache).nodes[0]!.exercises).toHaveLength(0);
    expect(
      buildIndex(docs, { exerciseSections: ["Custom"] }, cache).nodes[0]!
        .exercises,
    ).toHaveLength(1);
  });

  it("produces identical snapshots with cached parses and from scratch after arbitrary modifications", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 4 }),
            fc.constantFrom("add", "update", "delete", "rename"),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (ops) => {
          const docs = new Map<string, Source>();
          const cache = new Map();
          for (const [id, action] of ops) {
            const path = "Stage/Topic " + id + ".md";
            if (action === "delete") docs.delete(path);
            else if (action === "rename") {
              const old = docs.get(path);
              if (old) {
                docs.delete(path);
                const next = path.replace(".md", " moved.md");
                docs.set(next, { ...old, path: next });
              }
            } else
              docs.set(
                path,
                topic(
                  path,
                  action === "add" ? "unread" : "learning",
                  "[[Topic " + ((id + 1) % 5) + "]]",
                ),
              );
          }
          const inputs = Array.from(docs.values());
          const seeded = [...inputs, topic("Transient.md")];
          buildIndex(seeded, {}, cache);
          expect(buildIndex(inputs, {}, cache)).toEqual(
            buildIndex(inputs.toReversed()),
          );
        },
      ),
      { numRuns: 30 },
    );
  });
});
