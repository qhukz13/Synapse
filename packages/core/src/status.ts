export const conceptValues = [
  "unread",
  "learning",
  "understood",
  "practiced",
  "mastered",
];
export const projectValues = ["not-started", "in-progress", "completed"];
export const vocabulary = (kind: string) =>
  kind === "project" || kind === "course-project"
    ? projectValues
    : kind === "moc"
      ? ["not-started", ...conceptValues.slice(1)]
      : conceptValues;
export const category = (v: string) =>
  ["understood", "practiced", "mastered", "completed", "checked"].includes(v)
    ? "completed"
    : ["learning", "in-progress"].includes(v)
      ? "in_progress"
      : "not_started";
export type ResolvedStatus = {
  source: "frontmatter" | "course-checkbox" | "none";
  value: string;
  category: "completed" | "not_started" | "in_progress";
  reason: string;
  offset: number | null;
  unknown: boolean;
};
export function resolveStatus(
  kind: string,
  title: string,
  raw: unknown,
  boxes: { targets: string[]; checked: boolean; offset: number }[],
): ResolvedStatus {
  if (typeof raw === "string") {
    let value = raw.trim().toLowerCase();
    const project = kind === "project" || kind === "course-project";
    if (value === "in progress") value = project ? "in-progress" : "learning";
    if (project && value === "done") value = "completed";
    const unknown = !vocabulary(kind).includes(value);
    return {
      source: "frontmatter",
      value: unknown ? raw : value,
      category: unknown ? "not_started" : category(value),
      reason: "",
      offset: null,
      unknown,
    };
  }
  const matches = ["lesson", "course-project"].includes(kind)
    ? boxes.filter((b) =>
        b.targets.some((t) => t.toLowerCase() === title.toLowerCase()),
      )
    : [];
  const box = matches.length === 1 ? matches[0] : null;
  if (box?.targets.length === 1)
    return {
      source: "course-checkbox",
      value: box.checked ? "checked" : "unchecked",
      category: box.checked ? "completed" : "not_started",
      offset: box.offset,
      reason: "",
      unknown: false,
    };
  return {
    source: "none",
    value: "",
    category: "not_started",
    offset: null,
    reason: matches.length
      ? "ambiguous-checkbox"
      : ["lesson", "course-project"].includes(kind)
        ? "not-in-course-home"
        : "no-frontmatter",
    unknown: false,
  };
}
export function confirmTransition(from: string, to: string) {
  return (
    from !== to &&
    (to === "not-started" || (from === "not-started" && to === "completed"))
  );
}
