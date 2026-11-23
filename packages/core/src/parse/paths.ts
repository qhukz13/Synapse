/** All offsets are UTF-16 offsets into the full, original Markdown string. */
export type LearningTrack = "core" | "branch";

export interface PathPosition {
  target: string;
  stage: number;
  /** Global reading order, starting at zero. */
  index: number;
  /** Group ordinal within the stage, starting at zero. */
  group: number;
  parallel: boolean;
  checkpoint: boolean;
  track: LearningTrack;
  /** One-based source line for evidence and diagnostics. */
  line: number;
}

export interface PathStage {
  number: number;
  name: string;
  track: LearningTrack;
  goal: string | null;
  entryNotes: string[];
  groups: PathPosition[][];
}

export interface PathIssue {
  code: "learningPath.unparsed";
  severity: "warning";
  line: number;
  message: string;
}

export interface LearningPath {
  stages: PathStage[];
  positions: PathPosition[];
  issues: PathIssue[];
}

export interface CourseCheckbox {
  phase: number | null;
  kind: "lesson" | "build";
  targets: string[];
  checked: boolean;
  offset: number;
  line: number;
}

export interface CoursePhase {
  number: number;
  name: string;
  checkboxes: CourseCheckbox[];
}

export interface CourseHome {
  phases: CoursePhase[];
  checkboxes: CourseCheckbox[];
}

interface SourceLine {
  text: string;
  offset: number;
  line: number;
}

/** Yield structural lines only, preserving offsets through BOM, YAML, CRLF and code. */
function* outlineLines(markdown: string): Generator<SourceLine> {
  let offset = 0;
  let line = 0;
  let insideYaml = false;
  let fence: string | undefined;
  for (const raw of markdown.split("\n")) {
    const bom = line === 0 && raw.startsWith("\ufeff") ? 1 : 0;
    const text = raw.slice(bom).replace(/\r$/, "");
    const start = offset + bom;
    offset += raw.length + 1;
    line += 1;

    if (line === 1 && /^---\s*$/.test(text)) {
      insideYaml = true;
      continue;
    }
    if (insideYaml) {
      if (/^(---|\.\.\.)\s*$/.test(text)) insideYaml = false;
      continue;
    }

    const fenceMark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fenceMark) {
      const marker = fenceMark[1]!;
      if (!fence) fence = marker;
      else if (marker.startsWith(fence) && !fenceMark[2]!.trim())
        fence = undefined;
      continue;
    }
    if (fence || /^ {4}|^\t/.test(text)) continue;

    // Blanking code spans keeps the offsets of subsequent links unchanged.
    const visible = text.replace(/(`+)(?!`)(.+?)\1(?!`)/g, (span) =>
      " ".repeat(span.length),
    );
    yield { text: visible, offset: start, line };
  }
}

interface OutlineLink {
  target: string;
  start: number;
  end: number;
}

function wikiLinks(text: string): OutlineLink[] {
  const links: OutlineLink[] = [];
  for (const match of text.matchAll(/(?<![\\!])\[\[([^[\]]+)\]\]/g)) {
    const target = match[1]!.split(/[|#]/, 1)[0]!.trim();
    if (target)
      links.push({
        target,
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  return links;
}

export function parseLearningPath(markdown: string): LearningPath {
  const result: LearningPath = { stages: [], positions: [], issues: [] };
  let track: LearningTrack = "core";
  let stage: PathStage | undefined;
  const warn = (line: number, message: string) => {
    result.issues.push({
      code: "learningPath.unparsed",
      severity: "warning",
      line,
      message,
    });
  };

  for (const { text, line } of outlineLines(markdown)) {
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (heading) {
      const label = heading[2]!;
      if (heading[1] === "#") {
        if (/\bbranches\b/i.test(label)) track = "branch";
        stage = undefined;
      }
      if (heading[1] === "##") {
        stage = undefined;
        if (!/^Stage\b/i.test(label)) continue;
        const parts = /^Stage\s+(\d+)\s*[—–:-]\s*(.+)$/i.exec(label);
        if (
          !parts ||
          result.stages.some((existing) => existing.number === Number(parts[1]))
        ) {
          warn(line, "Stage heading needs a unique number and title.");
          continue;
        }
        stage = {
          number: Number(parts[1]),
          name: parts[2]!.trim(),
          track,
          goal: null,
          entryNotes: [],
          groups: [],
        };
        result.stages.push(stage);
      }
      continue;
    }
    if (!stage) continue;
    const goal = /^\s*[*_]*Goal[*_]*\s*:[*_]*\s*(.*)$/i.exec(text);
    if (goal) {
      stage.goal = goal[1]!
        .split(/\s+→\s+(?:MOC|Entry note)\b/i, 1)[0]!
        .trim()
        .replace(/[*_]+$/, "")
        .trim();
    }

    const links = wikiLinks(text);
    const entry =
      /(?:^|→)\s*[*_]*(?:MOC(?:\s*\/\s*Entry note)?|Entry note)[*_]*\s*:[*_]*/i.exec(
        text,
      );
    if (entry) {
      const candidates = links.filter(
        (link) => link.start >= entry.index + entry[0].length,
      );
      if (candidates.length === 0)
        warn(line, "The stage entry declaration has no target note.");
      for (const link of candidates) {
        if (!stage.entryNotes.includes(link.target))
          stage.entryNotes.push(link.target);
      }
    }

    const checkpoint =
      /^\s*(?:[-*]\s+)?(?:✅\s*)?[*_]*Checkpoint(?:s)?\b/i.test(text);
    const listItem = /^\s*(?:\d+[.)]|[-*+])\s/.test(text);
    if (!listItem && !checkpoint) continue;
    if (!links.length) {
      warn(line, "An ordered group or checkpoint has no target note.");
      continue;
    }
    const positions: PathPosition[] = [];
    for (const [i, link] of links.entries()) {
      const previous = links[i - 1];
      const next = links[i + 1];
      const parallel = Boolean(
        (previous && text.slice(previous.end, link.start).includes("·")) ||
        (next && text.slice(link.end, next.start).includes("·")),
      );
      const position = {
        target: link.target,
        stage: stage.number,
        index: result.positions.length,
        group: stage.groups.length,
        parallel,
        checkpoint,
        track,
        line,
      };
      result.positions.push(position);
      positions.push(position);
    }
    stage.groups.push(positions);
  }
  if (!result.stages.length && !result.issues.length)
    warn(1, "No numbered stages were found in the Learning Path.");
  return result;
}

export function parseCourseHome(markdown: string): CourseHome {
  const result: CourseHome = { phases: [], checkboxes: [] };
  let phase: CoursePhase | undefined;
  for (const { text, offset, line } of outlineLines(markdown)) {
    const heading = /^\s*###\s+Phase\s+(\d+)\s*[-—–:]\s*(.+?)\s*#*\s*$/i.exec(
      text,
    );
    if (heading) {
      phase = { number: Number(heading[1]), name: heading[2]!, checkboxes: [] };
      result.phases.push(phase);
      continue;
    }
    if (/^\s*#{1,3}\s/.test(text)) phase = undefined;
    const task = /^(\s*[-*+]\s+\[)([ xX])\]\s+(.+)$/.exec(text);
    if (!task) continue;
    const targets = wikiLinks(task[3]!).map((link) => link.target);
    if (!targets.length) continue;
    const isBuild =
      /\bBuild\b/i.test(task[3]!.split("[[", 1)[0]!) ||
      targets.some((target) => /(?:^|\/)Project\s*-\s*/i.test(target));
    const checkbox: CourseCheckbox = {
      phase: phase?.number ?? null,
      kind: isBuild ? "build" : "lesson",
      targets,
      checked: task[2]!.toLowerCase() === "x",
      offset: offset + task[1]!.length,
      line,
    };
    phase?.checkboxes.push(checkbox);
    result.checkboxes.push(checkbox);
  }
  return result;
}
