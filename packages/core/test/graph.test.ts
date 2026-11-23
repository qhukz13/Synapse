import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { analyzeGraph, type GraphNode } from "../src/graph";

const node = (
  slug: string,
  category = "not_started",
  order: number | null = null,
): GraphNode => ({ slug, category, order });
const edge = (from: string, to: string) => ({ from, to });

describe("advisory prerequisite analysis", () => {
  it("separates unmet, completed, future and missing topics and keeps missing edges", () => {
    const nodes = [
      node("fit", "in_progress", 2),
      node("algebra", "completed", 1),
      node("plot"),
      node("optimizer", "not_started", 4),
    ];
    const graph = analyzeGraph(
      nodes,
      ["algebra", "plot", "optimizer", "absent"].map((to) => edge("fit", to)),
    );
    expect(graph.prerequisites.fit).toEqual({
      met: ["algebra"],
      unmet: ["plot"],
      laterInPath: ["optimizer"],
      missing: ["absent"],
      cycleMembers: [],
      summary: "partial",
    });
    expect(graph.edges.find((e) => e.to === "absent")).toMatchObject({
      missing: true,
      laterInPath: false,
    });
    expect(graph.prerequisites.algebra?.summary).toBe("none");
  });

  it("marks future edges even when their target is already complete and omits incomplete future topics from the summary", () => {
    const nodes = [
      node("a", "in_progress", 0),
      node("b", "not_started", 1),
      node("c", "completed", 3),
    ];
    const graph = analyzeGraph(nodes, [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "c"),
    ]);
    expect(graph.prerequisites.a?.summary).toBe("met");
    expect(graph.prerequisites.a?.met).toEqual(["c"]);
    expect(graph.prerequisites.a?.laterInPath).toEqual(["b"]);
    expect(graph.edges.every((e) => e.laterInPath)).toBe(true);
    expect(analyzeGraph(nodes, [edge("a", "b")]).prerequisites.a?.summary).toBe(
      "none",
    );
    expect(analyzeGraph(nodes, [edge("c", "a")]).prerequisites.c?.summary).toBe(
      "unmet",
    );
  });

  it("identifies cycles, self-loops, and real external prerequisites of cycle members", () => {
    const nodes = ["a", "b", "c", "q", "x", "z"].map((slug) => node(slug));
    const graph = analyzeGraph(nodes, [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
      edge("c", "x"),
      edge("z", "z"),
      edge("q", "a"),
    ]);
    expect(graph.cycles).toEqual([["a", "b", "c"], ["z"]]);
    expect(graph.edges.filter((e) => e.inCycle).length).toBe(4);
    expect(graph.prerequisites.c).toMatchObject({
      cycleMembers: ["a"],
      unmet: ["x"],
      summary: "unmet",
    });
    expect(graph.prerequisites.z).toMatchObject({
      cycleMembers: ["z"],
      summary: "none",
    });
    expect(graph.prerequisites.q).toMatchObject({
      cycleMembers: [],
      unmet: ["a"],
    });
    expect(graph.edges.find((e) => e.to === "x")?.redundant).toBe(false);
  });

  it("marks implied prerequisite edges without removing or duplicating them", () => {
    const graph = analyzeGraph(
      ["a", "b", "c", "d"].map((slug) => node(slug)),
      [
        edge("d", "a"),
        edge("d", "c"),
        edge("c", "b"),
        edge("b", "a"),
        edge("d", "a"),
      ],
    );
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.filter((e) => e.redundant)).toMatchObject([
      edge("d", "a"),
    ]);
    expect(graph.prerequisites.d?.unmet).toEqual(["a", "c"]);
  });

  it("produces the same analysis under reordered nodes and edges, including duplicates and ghosts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 4 }),
            fc.integer({ min: 0, max: 5 }),
          ),
          { maxLength: 25 },
        ),
        (pairs) => {
          const nodes = ["0", "1", "2", "3", "4"].map((slug) => node(slug));
          const edges = pairs.map(([a, b]) => edge(String(a), String(b)));
          expect(analyzeGraph(nodes, edges)).toEqual(
            analyzeGraph(nodes.toReversed(), edges.toReversed()),
          );
        },
      ),
    );
  });
});
