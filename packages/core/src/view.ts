import type { Topic, VaultIndex } from "./index";
export function topicRow(n: Topic) {
  return {
    slug: n.slug,
    title: n.title,
    kind: n.kind,
    stage: n.stage,
    folder: n.folder,
    path: n.path,
    domain: n.domain,
    difficulty: String(n.fm.meta.difficulty ?? ""),
    importance: String(n.fm.meta.importance ?? ""),
    tags: Array.isArray(n.fm.meta.tags) ? n.fm.meta.tags.map(String) : [],
    status: n.status,
    position: n.position,
    about: n.about,
    mtimeMs: n.mtimeMs,
    readingMinutes: n.readingMinutes,
    exercises: n.exercises.length,
    invalid: !!n.fm.error,
  };
}
export type TopicRow = ReturnType<typeof topicRow>;
export function catalogue(index: VaultIndex) {
  return {
    topics: index.nodes.map(topicRow),
    edges: index.edges,
    prerequisites: index.prerequisites,
    learningPath: index.learningPath,
    course: index.course,
  };
}
export type Catalogue = ReturnType<typeof catalogue>;
