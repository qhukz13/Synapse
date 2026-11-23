/** Directed edges point from a topic to its prerequisite. */
export interface GraphNode {
  slug: string;
  category: string;
  order: number | null;
}

export interface PrerequisiteEdge {
  from: string;
  to: string;
}

export interface AnalyzedEdge extends PrerequisiteEdge {
  laterInPath: boolean;
  redundant: boolean;
  inCycle: boolean;
  missing: boolean;
}

export interface PrerequisiteStatus {
  met: string[];
  unmet: string[];
  laterInPath: string[];
  missing: string[];
  cycleMembers: string[];
  summary: "none" | "met" | "partial" | "unmet";
}

export interface GraphAnalysis {
  edges: AnalyzedEdge[];
  prerequisites: Record<string, PrerequisiteStatus>;
  cycles: string[][];
}

const compareKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Tarjan's algorithm visits real nodes only. Missing dependencies remain visible as edges. */
function cycleComponents(graph: ReadonlyMap<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(node: string) {
    const number = index.size;
    index.set(node, number);
    low.set(node, number);
    onStack.add(node);
    stack.push(node);

    for (const target of graph.get(node)!) {
      if (!graph.has(target)) continue;
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) !== number) return;
    const component = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || graph.get(node)!.includes(node)) {
      cycles.push(component.sort(compareKey));
    }
  }

  for (const node of graph.keys()) {
    if (!index.has(node)) visit(node);
  }
  return cycles.sort((a, b) => compareKey(a[0]!, b[0]!));
}

/** True if another direct dependency has its own path to the same target. */
function hasOtherPath(
  graph: ReadonlyMap<string, string[]>,
  from: string,
  to: string,
): boolean {
  const pending = graph.get(from)!.filter((node) => node !== to);
  const visited = new Set([from]);
  while (pending.length) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      if (next === to) return true;
      if (!visited.has(next)) pending.push(next);
    }
  }
  return false;
}

function blankStatus(): PrerequisiteStatus {
  return {
    met: [],
    unmet: [],
    laterInPath: [],
    missing: [],
    cycleMembers: [],
    summary: "none",
  };
}

export function analyzeGraph(
  nodes: readonly GraphNode[],
  inputEdges: readonly PrerequisiteEdge[],
): GraphAnalysis {
  const bySlug = new Map(nodes.map((node) => [node.slug, node]));
  const children = new Map<string, Set<string>>();
  for (const slug of Array.from(bySlug.keys()).sort(compareKey))
    children.set(slug, new Set());
  for (const { from, to } of inputEdges) children.get(from)?.add(to);
  const graph = new Map(
    Array.from(children, ([slug, targets]) => [
      slug,
      [...targets].sort(compareKey),
    ]),
  );
  const cycles = cycleComponents(graph);
  const component = new Map<string, number>();
  cycles.forEach((members, id) =>
    members.forEach((node) => component.set(node, id)),
  );

  const edges: AnalyzedEdge[] = [];
  const prerequisites: Record<string, PrerequisiteStatus> = Object.create(null);
  for (const [from, targets] of graph) {
    const source = bySlug.get(from)!;
    const status = blankStatus();
    prerequisites[from] = status;
    for (const to of targets) {
      const target = bySlug.get(to);
      const missing = !target;
      const inCycle =
        component.has(from) && component.get(from) === component.get(to);
      const laterInPath =
        source.order !== null &&
        target?.order != null &&
        source.order < target.order;
      edges.push({
        from,
        to,
        missing,
        inCycle,
        laterInPath,
        redundant: hasOtherPath(graph, from, to),
      });
      if (missing) status.missing.push(to);
      else if (inCycle) status.cycleMembers.push(to);
      else if (target.category === "completed") status.met.push(to);
      else if (laterInPath) status.laterInPath.push(to);
      else status.unmet.push(to);
    }
    if (status.unmet.length || status.missing.length)
      status.summary = status.met.length ? "partial" : "unmet";
    else if (status.met.length) status.summary = "met";
  }
  return { edges, prerequisites, cycles };
}
