import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parse } from "yaml";
import {
  addFrontmatter,
  appendText,
  PatchError,
  replaceRange,
  setFrontmatterList,
  setFrontmatterScalar,
  toggleCheckbox,
} from "../src/patch";
const wrap = (yaml: string) =>
  "---\n" + yaml + "\n---\n# Study\n\nAn unchanged paragraph.\n";

describe("C1–C6, C19 | semantic patches", () => {
  it("preserves comments, key order, source bytes, BOM, CRLF and original quoting", () => {
    const source =
      "\uFEFF---  \r\n# progress\r\nstatus :  'unread' # comment\r\nunknown: {v: 2}\r\n---\r\nизучение\r\n";
    const changed = setFrontmatterScalar(source, "status", "learner's choice");
    expect(changed).toBe(source.replace("'unread'", "'learner''s choice'"));
    expect(setFrontmatterScalar(changed, "status", "learner's choice")).toBe(
      changed,
    );
  });

  it("adds a missing field while preserving indentation and unknown nested mappings", () => {
    const source = wrap("  type: moc\n  x: {setting: 13}\n  # provenance");
    expect(setFrontmatterList(source, "prerequisites", ["A", "A, B"])).toBe(
      wrap(
        '  type: moc\n  x: {setting: 13}\n  # provenance\n  prerequisites: [A, "A, B"]',
      ),
    );
  });

  it("edits and appends to flow sequences using existing quote styles", () => {
    const source = wrap('prerequisites: [ A,  "B", ] # list\nsource: xyz');
    const added = setFrontmatterList(source, "prerequisites", [
      "A",
      'New "label"',
      "C",
    ]);
    expect(added).toBe(
      wrap(
        'prerequisites: [ A,  "New \\"label\\"", "C", ] # list\nsource: xyz',
      ),
    );
    expect(setFrontmatterList(added, "prerequisites", ["A"])).toBe(
      wrap("prerequisites: [ A, ] # list\nsource: xyz"),
    );
    expect(setFrontmatterList(source, "prerequisites", [])).toBe(
      wrap("prerequisites: [  ] # list\nsource: xyz"),
    );
  });
  it("appends block items while keeping bullet spacing and inline comments", () => {
    const source = wrap(
      "prerequisites: # references\n  -  A # keep\n  # note\n  -  'B'\nsource: xyz",
    );
    const added = setFrontmatterList(source, "prerequisites", [
      "A",
      "Two",
      "Three",
    ]);
    expect(added).toBe(source.replace("  -  'B'", "  -  'Two'\n  -  'Three'"));
    expect(setFrontmatterList(source, "prerequisites", [])).toBe(
      wrap("prerequisites: [] # references\n  # keep\n  # note\nsource: xyz"),
    );
  });
  it("uses a bounded edit for a simple value inside complex flow lists; refuses unsafe changes of length", () => {
    const src = wrap("prerequisites: [A,\n  # keep\n  B]");
    expect(setFrontmatterList(src, "prerequisites", ["A", "C"])).toBe(
      src.replace("B]", "C]"),
    );
    expect(() => setFrontmatterList(src, "prerequisites", [])).toThrow(
      PatchError,
    );
  });
  it.each([
    "status: &original unread\nx: *original",
    "status: unread\nx: &name original",
    "status: unread\nx: *missing",
    "status: unread\nstatus: done",
    "status: !custom unread",
    "? [a, b]\n: 1\nstatus: unread",
    "? status\n: unread",
    "status: unread\n...\n",
    "status: [",
    "status: |\n  multiple lines",
    "status: unread\nx:\n  nested: &secret hello",
  ])("rejects unsupported YAML safely %#", (yaml) => {
    expect(() => setFrontmatterScalar(wrap(yaml), "status", "changed")).toThrow(
      PatchError,
    );
  });
  it("prepends only, retaining BOM and source line endings and quoting ambiguous strings", () => {
    const source = "\uFEFF# Page\r\nFull text.\r\n";
    const fields = {
      type: "lesson",
      status: "unread",
      about: ["[[Sample]]"],
      example: "false",
    };
    const patched = addFrontmatter(source, fields);
    expect(patched).toBe(
      '\uFEFF---\r\ntype: lesson\r\nstatus: unread\r\nabout: ["[[Sample]]"]\r\nexample: "false"\r\n---\r\n' +
        source.slice(1),
    );
    expect(() => addFrontmatter(patched, fields)).toThrow(PatchError);
    expect(() => addFrontmatter("---\nunterminated", fields)).toThrow(
      PatchError,
    );
    expect(() => addFrontmatter(source, {})).toThrow(PatchError);
    expect(() => addFrontmatter(source, { "field\nname": "x" })).toThrow(
      PatchError,
    );
  });
  it("checks range and expected bytes; append preserves source exactly", () => {
    expect(replaceRange("ab cd", 3, 5, "cd", "☀")).toBe("ab ☀");
    expect(appendText("a\r\n", "\r\nb")).toBe("a\r\n\r\nb");
    for (const [a, b] of [
      [-1, 4],
      [0.5, 3],
      [3, 2],
      [4, 7],
      [1, 3],
    ] as const) {
      expect(() => replaceRange("example", a, b, "zzz", "")).toThrow(
        PatchError,
      );
    }
  });
  it("toggles one real checkbox, preserves uppercase checked no-op, rejects stale and code offsets", () => {
    const src =
      "# Практика\r\n\r\n- [X] first\r\n- [ ] second\r\n\r\n```md\r\n- [ ] Plain code\r\n```\r\n";
    const off = src.indexOf("[ ]") + 1;
    expect(toggleCheckbox(src, off, false, true)).toBe(
      src.replace("[ ] second", "[x] second"),
    );
    expect(toggleCheckbox(src, src.indexOf("X"), true, true)).toBe(src);
    expect(() => toggleCheckbox(src, off, true, false)).toThrow(PatchError);
    expect(() =>
      toggleCheckbox(src, src.lastIndexOf("[ ]") + 1, false, true),
    ).toThrow(PatchError);
    expect(() => toggleCheckbox(src, -1, false, true)).toThrow(PatchError);
  });
  it("round-trips arbitrary metadata and preserves unrelated bytes and idempotence", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.string(), { maxLength: 8 }),
        fc.array(fc.string(), { maxLength: 8 }),
        fc.constantFrom("\n", "\r\n"),
        fc.boolean(),
        (value, initial, list, eol, bom) => {
          const field = 'status: "starting" # keep';
          const suffix =
            'unknown: {keep: "value"}' +
            eol +
            "---" +
            eol +
            "# Private fixture" +
            eol;
          const source =
            (bom ? "\uFEFF" : "") +
            "---" +
            eol +
            field +
            eol +
            "items: " +
            JSON.stringify(initial) +
            eol +
            suffix;
          const changed = setFrontmatterScalar(source, "status", value);
          expect(changed).toBe(
            source.replace('"starting"', () => JSON.stringify(value)),
          );
          const next = setFrontmatterList(changed, "items", list);
          const data = parse(
            next.replace(/^\uFEFF?---\r?\n/, "").split(eol + "---")[0]!,
          );
          expect(data).toEqual({
            status: value,
            items: list,
            unknown: { keep: "value" },
          });
          expect(next.endsWith(suffix)).toBe(true);
          expect(setFrontmatterList(next, "items", list)).toBe(next);
          expect(setFrontmatterScalar(next, "status", value)).toBe(next);
        },
      ),
      { numRuns: 150 },
    );
  });
});
