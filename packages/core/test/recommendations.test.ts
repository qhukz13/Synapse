import { describe, expect, it } from "vitest";
import {
  recommendTopics,
  type RecommendationTopic,
} from "../src/recommendations";
import type { PrerequisiteStatus } from "../src/graph";
const status = (unmet: string[] = []): PrerequisiteStatus => ({
  met: [],
  unmet,
  laterInPath: [],
  missing: [],
  cycleMembers: [],
  summary: unmet.length ? "unmet" : "none",
});
const topic = (
  slug: string,
  category = "not_started",
  kind = "concept",
): RecommendationTopic => ({
  slug,
  title: slug,
  kind,
  stage: 2,
  domain: "Math",
  track: "core",
  importance: "medium",
  difficulty: "beginner",
  category,
  order: null,
});
describe("deterministic topic recommendations", () => {
  it("keeps prerequisite-incomplete topics available and ranks ready topics first", () => {
    const result = recommendTopics([topic("needs-base"), topic("ready")], {
      "needs-base": status(["ready"]),
      ready: status(),
    });
    expect(result.next.map((x) => x.slug)).toEqual(["ready", "needs-base"]);
    expect(result.all.map((x) => x.slug)).toHaveLength(2);
    expect(result.next[1]?.reasons[0]).toBe("Builds on ready");
  });
  it("puts recent in-progress work first and is independent of input order", () => {
    const inputs = [
      topic("early", "not_started"),
      topic("now", "in_progress"),
      topic("recent", "in_progress"),
    ];
    const activity = { now: 10, recent: 20 };
    const forward = recommendTopics(inputs, {}, activity).all.map(
      (x) => x.slug,
    );
    const reverse = recommendTopics(
      [...inputs].reverse(),
      {},
      activity,
    ).all.map((x) => x.slug);
    expect(forward).toEqual(["recent", "now", "early"]);
    expect(reverse).toEqual(forward);
  });
  it("excludes completed work and non-curriculum notes", () => {
    const result = recommendTopics(
      [
        topic("done", "completed"),
        topic("journal", "not_started", "note"),
        topic("lesson", "not_started", "lesson"),
      ],
      {},
    );
    expect(result.all.map((x) => x.slug)).toEqual(["lesson"]);
  });
  it("keeps a recently studied topic in Continue even when its status is unchanged", () => {
    const result = recommendTopics(
      [topic("study"), topic("next")],
      {},
      {},
      {},
      new Set(["study"]),
    );
    expect(result.continue.map((item) => item.slug)).toEqual(["study"]);
    expect(result.next.map((item) => item.slug)).toEqual(["next"]);
    expect(result.continue[0]?.reasons[0]).toBe("Studied recently");
  });
  it("includes only MOCs identified as curriculum entry points",()=>{
    const generic={...topic("index","not_started","moc"),introMoc:false};
    const entry={...topic("entry","not_started","moc"),introMoc:true};
    expect(recommendTopics([generic,entry],{}).all.map(item=>item.slug)).toEqual(["entry"]);
  });
});
