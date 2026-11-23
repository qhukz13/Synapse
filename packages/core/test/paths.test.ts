import { describe, expect, it } from "vitest";
import { parseCourseHome, parseLearningPath } from "../src/parse/paths";

describe("Learning Path outline", () => {
  it("retains stage order, entry evidence, parallel groups and checkpoint order", () => {
    const text = [
      "# Path",
      "## Stage 1 — Signals",
      "*Goal:* Read simple signals.",
      "→ MOC: [[Signal index|Index]]",
      "1. [[Sample]] → [[Rate]] · [[Delay]]",
      "2. [[Model#Response|Response]]",
      "✅ **Checkpoint:** [[Project Red]] → [[Project Blue]]",
      "# Branches",
      "## Stage 14 — Acoustics",
      "*Goal: Hear pitch.* → Entry note: [[Sound]]",
      "- [[Echo]]",
    ].join("\n");
    const { stages, positions, issues } = parseLearningPath(text);
    expect(issues).toEqual([]);
    expect(
      stages.map((s) => [s.number, s.name, s.entryNotes, s.track]),
    ).toEqual([
      [1, "Signals", ["Signal index"], "core"],
      [14, "Acoustics", ["Sound"], "branch"],
    ]);
    expect(stages[0]?.goal).toBe("Read simple signals.");
    expect(stages[1]?.goal).toBe("Hear pitch.");
    expect(
      positions.map((p) => [p.target, p.group, p.parallel, p.checkpoint]),
    ).toEqual([
      ["Sample", 0, false, false],
      ["Rate", 0, true, false],
      ["Delay", 0, true, false],
      ["Model", 1, false, false],
      ["Project Red", 2, false, true],
      ["Project Blue", 2, false, true],
      ["Echo", 0, false, false],
    ]);
    expect(positions.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("reports malformed structured lines and duplicates without discarding valid stages", () => {
    const { stages, issues } = parseLearningPath(
      [
        "## Stage A — Bad header",
        "## Stage 2: Tables",
        "1. Add columns",
        "→ Entry note: No wiki-link",
        "2. [[Row]]",
        "## Stage 2: Duplicate",
      ].join("\n"),
    );
    expect(issues.map((issue) => issue.line)).toEqual([1, 3, 4, 6]);
    expect(stages[0]?.groups[0]?.[0]?.target).toBe("Row");
    expect(parseLearningPath("Plain prose").issues[0]?.code).toBe(
      "learningPath.unparsed",
    );
  });

  it("ignores fenced blocks, frontmatter, examples, and other headings", () => {
    const lines = [
      "\ufeff---",
      "## Stage 33 — Fake",
      "---",
      "## Stage 4 — Pixels",
      "````text",
      "```",
      "1. [[Fence]]",
      "````",
      "    2. [[Indented]]",
      "3. `[[Inline]]` [[Visible]]",
      "4. [[Alpha]] + \\[[Escaped]] + ![[Embedded]]",
      "## Extra reading",
      "1. [[Unordered reading]]",
    ];
    expect(
      parseLearningPath(lines.join("\r\n")).positions.map((p) => p.target),
    ).toEqual(["Visible", "Alpha"]);
  });
});

describe("Course Home checkboxes", () => {
  it("retains the phase, type, all targets and precise checkbox offset in the original source", () => {
    const lines = [
      "\ufeff---",
      "status: unread",
      "---",
      "# 🎧 Audio",
      "### Phase 1 — Waveforms",
      "- [ ] [[01 - Reading samples|Read]]",
      "- [X] **Build:** [[Projects/Project - Listener]] or [[Project - Meter]]",
      "### Phase 2 — Time",
      "* [x] [[02 - Intervals#Explanations]]",
    ];
    const text = lines.join("\r\n");
    const { phases, checkboxes } = parseCourseHome(text);
    expect(phases.map((p) => p.checkboxes.length)).toEqual([2, 1]);
    expect(
      checkboxes.map((c) => [c.phase, c.kind, c.targets, c.checked, c.line]),
    ).toEqual([
      [1, "lesson", ["01 - Reading samples"], false, 6],
      [1, "build", ["Projects/Project - Listener", "Project - Meter"], true, 7],
      [2, "lesson", ["02 - Intervals"], true, 9],
    ]);
    expect(checkboxes.map((c) => text[c.offset])).toEqual([" ", "X", "x"]);
  });

  it("ignores code and unrelated unlinked checkboxes", () => {
    const text = [
      "~~~md",
      "### Phase 3 — Ignored",
      "- [x] [[Code]]",
      "~~~",
      "- [ ] Manual reminder",
      "- [x] `[[Snippet]]`",
      "- [x] [[Real]]",
    ].join("\n");
    expect(parseCourseHome(text)).toEqual({
      phases: [],
      checkboxes: [
        {
          phase: null,
          kind: "lesson",
          targets: ["Real"],
          checked: true,
          offset: text.lastIndexOf("[x]") + 1,
          line: 7,
        },
      ],
    });
  });
});
