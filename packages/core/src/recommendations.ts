import type { PrerequisiteStatus } from "./graph";

export type RecommendationTopic = {
  slug: string;
  title: string;
  kind: string;
  stage: number;
  domain: string;
  track: string;
  importance: string;
  difficulty: string;
  category: string;
  order: number | null;
  introMoc?: boolean;
};
export type Recommendation = RecommendationTopic & {
  reasons: string[];
  prerequisiteStatus: PrerequisiteStatus;
};
const rank = (value: string, ordered: string[]) => {
  const index = ordered.indexOf(value.toLowerCase());
  return index < 0 ? ordered.length : index;
};

/** Stable curriculum suggestions. Prerequisites influence ordering, never eligibility. */
export function recommendTopics(
  topics: readonly RecommendationTopic[],
  prerequisites: Record<string, PrerequisiteStatus>,
  lastActivity: Record<string, number> = {},
  dependents: Record<string, number> = {},
  recentlyStudied: ReadonlySet<string> = new Set(),
) {
  const bySlug = new Map(topics.map((topic) => [topic.slug, topic]));
  const eligible = topics.filter(
    (topic) =>
      (["concept", "lesson", "intro-moc"].includes(topic.kind) ||
        (topic.kind === "moc" && topic.introMoc === true)) &&
      topic.category !== "completed",
  );
  const compareNext = (a: RecommendationTopic, b: RecommendationTopic) => {
    const aPre = prerequisites[a.slug] ?? emptyPrereqs();
    const bPre = prerequisites[b.slug] ?? emptyPrereqs();
    const score = (p: PrerequisiteStatus) =>
      p.summary === "partial" ? 1 : p.summary === "unmet" ? 2 : 0;
    return (
      score(aPre) - score(bPre) ||
      rank(a.track, ["core", "branch"]) - rank(b.track, ["core", "branch"]) ||
      a.stage - b.stage ||
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) ||
      rank(a.importance, ["high", "medium", "low"]) -
        rank(b.importance, ["high", "medium", "low"]) ||
      (dependents[b.slug] ?? 0) - (dependents[a.slug] ?? 0) ||
      rank(a.difficulty, ["beginner", "intermediate", "advanced"]) -
        rank(b.difficulty, ["beginner", "intermediate", "advanced"]) ||
      a.title.localeCompare(b.title)
    );
  };
  const continuing = eligible
    .filter(
      (topic) =>
        topic.category === "in_progress" || recentlyStudied.has(topic.slug),
    )
    .sort(
      (a, b) =>
        (lastActivity[b.slug] ?? 0) - (lastActivity[a.slug] ?? 0) ||
        compareNext(a, b),
    );
  const continuingSlugs = new Set(continuing.map((topic) => topic.slug));
  const next = eligible
    .filter((topic) => !continuingSlugs.has(topic.slug))
    .sort(compareNext);
  const explain = (topic: RecommendationTopic): Recommendation => {
    const prerequisiteStatus = prerequisites[topic.slug] ?? emptyPrereqs();
    const names = [...prerequisiteStatus.met, ...prerequisiteStatus.unmet]
      .map((slug) => bySlug.get(slug)?.title ?? slug)
      .slice(0, 3);
    const reasons = [
      continuingSlugs.has(topic.slug)
        ? topic.category === "in_progress"
          ? "Already marked in progress"
          : "Studied recently"
        : prerequisiteStatus.unmet.length || prerequisiteStatus.missing.length
          ? names.length
            ? `Builds on ${names.join(", ")}`
            : "Suggested prerequisites are listed"
          : prerequisiteStatus.met.length
            ? "Recorded prerequisites are complete"
            : "No prerequisites are recorded",
    ];
    if (topic.domain) reasons.push(`Part of ${topic.domain}`);
    return { ...topic, reasons, prerequisiteStatus };
  };
  const ordered = [...continuing, ...next];
  const oneAway = eligible.filter((topic) => {
    const status = prerequisites[topic.slug];
    return status && status.unmet.length + status.missing.length === 1;
  });
  return {
    continue: continuing.map(explain),
    next: next.map(explain),
    oneAway: oneAway.map(explain),
    all: ordered.map(explain),
  };
}
function emptyPrereqs(): PrerequisiteStatus {
  return {
    met: [],
    unmet: [],
    laterInPath: [],
    missing: [],
    cycleMembers: [],
    summary: "none",
  };
}
