import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit, SKIP } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import { sha1 } from "@noble/hashes/sha1";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { resourceInfo } from "./resources";
export const fingerprint = (s: string) =>
  bytesToHex(
    sha1(
      utf8ToBytes(
        s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
      ),
    ),
  );
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export function structure(
  source: string,
  bodyStart: number,
  exerciseSections = [
    "Exercises",
    "Steps",
    "Milestones",
    "Stretch goals",
    "Stretch",
  ],
) {
  const body = source.slice(bodyStart),
    tree = parser.parse(body);
  const sections: { title: string; start: number; end: number }[] = [];
  const links: {
    target: string;
    label: string;
    section: string;
    offset: number;
    raw: string;
    line: number;
    personalCallout: boolean;
  }[] = [];
  const resources: {
    url: string;
    title: string;
    role: string;
    group: string;
    id: string;
    kind: string;
    videoId: string | null;
    listId: string | null;
    start: number;
    insecure: boolean;
  }[] = [];
  const exercises: {
    text: string;
    section: string;
    ordinal: number;
    fingerprint: string;
    offset: number | null;
    checked: boolean | null;
  }[] = [];
  const noteCallouts: { start: number; end: number }[] = [];
  let section = "",
    role = "listed",
    heading = "",
    hasMath = false;
  const sectionsSet = new Set(exerciseSections.map((s) => s.toLowerCase()));
  visit(tree, (n) => {
    const start = (n.position?.start.offset ?? 0) + bodyStart,
      end = (n.position?.end.offset ?? 0) + bodyStart;
    if (
      n.type === "blockquote" &&
      /^>\s*\[!note\]\s+Your notes\b/i.test(source.slice(start, end))
    )
      noteCallouts.push({ start, end });
    if (n.type === "code" || n.type === "inlineCode") return SKIP;
    if (n.type === "math" || n.type === "inlineMath") {
      hasMath = true;
      return SKIP;
    }
    if (n.type === "heading") {
      if (n.depth === 1 && !heading)
        heading = toString(n).replace(/^[^\p{L}\p{N}]+/u, "");
      if (n.depth === 2) {
        if (sections.length) sections[sections.length - 1]!.end = start;
        section = toString(n);
        sections.push({ title: section, start, end: source.length });
        role = "listed";
      }
    }
    if (n.type === "strong" && /^(primary|supplementary)\b/i.test(toString(n)))
      role = toString(n).split(/\W/)[0]!.toLowerCase();
    if (n.type === "link" && /^https?:\/\//i.test(n.url)) {
      try {
        resources.push({
          url: n.url,
          title: toString(n) || n.url,
          role,
          group: section,
          id: fingerprint(n.url),
          ...resourceInfo(n.url),
        });
      } catch {
        /* malformed external URL */
      }
    }
    if (n.type === "text") {
      const raw = source.slice(start, end);
      for (const m of raw.matchAll(/(?<!\\)\[\[([^\]\n]+)\]\]/g)) {
        const [dest, alias] = m[1]!.split("|"),
          target = dest!.split("#")[0]!.trim();
        if (target)
          links.push({
            target,
            personalCallout: noteCallouts.some(
              (r) => start >= r.start && end <= r.end,
            ),
            label: alias || dest!,
            section,
            offset: start + m.index!,
            raw: m[0],
            line:
              (n.position?.start.line ?? 1) +
              raw.slice(0, m.index).split("\n").length -
              1 +
              source.slice(0, bodyStart).split("\n").length -
              1,
          });
      }
    }
    if (
      n.type === "listItem" &&
      (n.checked != null || sectionsSet.has(section.toLowerCase()))
    ) {
      const text = toString(n.children[0] ?? n);
      const marker = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(
        source.slice(start, end),
      );
      exercises.push({
        text,
        section,
        ordinal: exercises.filter((e) => e.section === section).length,
        fingerprint: fingerprint(text),
        offset: marker ? start + marker[0].length - 2 : null,
        checked: n.checked ?? null,
      });
    }
  });
  return {
    heading,
    sections,
    links,
    resources,
    exercises,
    hasMath,
    readingMinutes: Math.ceil(body.split(/\s+/).filter(Boolean).length / 220),
  };
}
