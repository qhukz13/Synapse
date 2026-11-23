import { z } from "zod";
import type { Context } from "../app";
import { transaction } from "../db/transaction";

function similarity(left: string, right: string) {
  const words = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = words(left),
    b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export function registerPractice({ app, state, topic, nid }: Context) {
  const read = (slug: string) => {
    const note = topic(slug);
    const noteId = nid(slug);
    const current = note.exercises.filter((item) => item.offset === null);
    const rows = state.db
      .prepare(
        "SELECT fingerprint,section,ordinal,text_snapshot,done_at,orphaned_at FROM exercise_progress WHERE nid=?",
      )
      .all(noteId) as unknown as {
      fingerprint: string;
      section: string;
      ordinal: number;
      text_snapshot: string;
      done_at: number;
      orphaned_at: number | null;
    }[];
    const claimed = new Set<string>();
    const done = new Set<string>();
    for (const row of rows) {
      const exact = current.find(
        (item) => item.fingerprint === row.fingerprint,
      );
      if (exact) {
        claimed.add(exact.fingerprint);
        done.add(exact.fingerprint);
        if (row.orphaned_at !== null)
          state.db
            .prepare(
              "UPDATE exercise_progress SET orphaned_at=NULL,section=?,ordinal=?,text_snapshot=? WHERE nid=? AND fingerprint=?",
            )
            .run(
              exact.section,
              exact.ordinal,
              exact.text,
              noteId,
              row.fingerprint,
            );
        continue;
      }
      const fallback = current
        .filter(
          (item) =>
            !claimed.has(item.fingerprint) &&
            item.section === row.section &&
            item.ordinal === row.ordinal,
        )
        .map((item) => ({
          item,
          score: similarity(row.text_snapshot, item.text),
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (fallback && fallback.score >= 0.6) {
        transaction(state.db, () => {
          state.db
            .prepare(
              "DELETE FROM exercise_progress WHERE nid=? AND fingerprint=?",
            )
            .run(noteId, row.fingerprint);
          state.db
            .prepare(
              "INSERT INTO exercise_progress(nid,fingerprint,section,ordinal,text_snapshot,done_at,orphaned_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(nid,fingerprint) DO UPDATE SET section=excluded.section,ordinal=excluded.ordinal,text_snapshot=excluded.text_snapshot,done_at=excluded.done_at,orphaned_at=NULL",
            )
            .run(
              noteId,
              fallback.item.fingerprint,
              fallback.item.section,
              fallback.item.ordinal,
              fallback.item.text,
              row.done_at,
            );
        });
        claimed.add(fallback.item.fingerprint);
        done.add(fallback.item.fingerprint);
      } else if (row.orphaned_at === null) {
        state.db
          .prepare(
            "UPDATE exercise_progress SET orphaned_at=? WHERE nid=? AND fingerprint=?",
          )
          .run(Date.now(), noteId, row.fingerprint);
      }
    }
    const currentFingerprints = new Set(
      current.map((item) => item.fingerprint),
    );
    const orphans = state.db
      .prepare(
        "SELECT fingerprint,section,ordinal,text_snapshot,done_at,orphaned_at FROM exercise_progress WHERE nid=? AND orphaned_at IS NOT NULL ORDER BY done_at DESC",
      )
      .all(noteId) as unknown as typeof rows;
    return {
      slug,
      title: note.title,
      exercises: note.exercises.map((item) => ({
        ...item,
        done:
          item.offset === null
            ? done.has(item.fingerprint)
            : item.checked === true,
        source: item.offset === null ? "app" : "markdown",
      })),
      orphans: orphans.filter(
        (item) => !currentFingerprints.has(item.fingerprint),
      ),
    };
  };

  app.get<{ Params: { slug: string } }>("/api/practice/:slug", (request) =>
    read(request.params.slug),
  );
  app.post<{ Params: { slug: string } }>("/api/practice/:slug", (request) => {
    const { fingerprint, done } = z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{40}$/),
        done: z.boolean(),
      })
      .strict()
      .parse(request.body);
    const note = topic(request.params.slug);
    const exercise = note.exercises.find(
      (item) => item.fingerprint === fingerprint,
    );
    if (!exercise)
      throw Object.assign(Error("Exercise is no longer in this note."), {
        statusCode: 409,
      });
    if (exercise.offset !== null)
      throw Object.assign(
        Error("This checklist is stored in the Markdown file."),
        { statusCode: 409 },
      );
    const noteId = nid(request.params.slug);
    if (done) {
      state.db
        .prepare(
          "INSERT INTO exercise_progress(nid,fingerprint,section,ordinal,text_snapshot,done_at,orphaned_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(nid,fingerprint) DO UPDATE SET section=excluded.section,ordinal=excluded.ordinal,text_snapshot=excluded.text_snapshot,done_at=excluded.done_at,orphaned_at=NULL",
        )
        .run(
          noteId,
          exercise.fingerprint,
          exercise.section,
          exercise.ordinal,
          exercise.text,
          Date.now(),
        );
    } else {
      state.db
        .prepare("DELETE FROM exercise_progress WHERE nid=? AND fingerprint=?")
        .run(noteId, exercise.fingerprint);
    }
    return read(request.params.slug);
  });
}
