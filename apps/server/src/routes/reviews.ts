import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context } from "../app";
import { transaction } from "../db/transaction";

const reviewInput = z
  .object({
    slug: z.string().min(1),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const completionInput = z
  .object({
    confidence: z.number().int().min(1).max(3).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export function registerReviews({ app, state, topic, nid }: Context) {
  app.get("/api/reviews", (request) => {
    const query = z
      .object({ history: z.enum(["true", "false"]).optional() })
      .strict()
      .parse(request.query);
    if (query.history === "true") {
      return state.db
        .prepare(
          `SELECT l.id AS log_id,l.review_item_id AS id,l.nid,i.slug,i.title,l.completed_at,l.confidence,l.note,r.due_date AS dueDate,r.reason
         FROM review_log l JOIN node_identity i ON i.nid=l.nid JOIN review_item r ON r.id=l.review_item_id
         ORDER BY l.completed_at DESC LIMIT 100`,
        )
        .all();
    }
    return state.db
      .prepare(
      `SELECT r.id,r.due_date AS dueDate,r.reason,r.created_at AS createdAt,i.slug,i.title,i.kind
       FROM review_item r JOIN node_identity i ON i.nid=r.nid WHERE r.state='queued'
       ORDER BY CASE WHEN r.due_date IS NULL THEN 1 ELSE 0 END,r.due_date,r.created_at`,
      )
      .all();
  });

  app.post("/api/reviews", async (request, reply) => {
    const input = reviewInput.parse(request.body);
    const item = topic(input.slug);
    const id = nid(item.slug);
    if (input.dueDate) {
      const date = new Date(`${input.dueDate}T00:00:00Z`);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== input.dueDate
      )
        throw Object.assign(new Error("Choose a valid review date."), {
          statusCode: 422,
        });
    }
    const existing = state.db
      .prepare("SELECT id FROM review_item WHERE nid=? AND state='queued'")
      .get(id) as { id: string } | undefined;
    if (existing)
      throw Object.assign(
        new Error("This topic is already in the review queue."),
        { statusCode: 409 },
      );
    const reviewId = randomUUID();
    transaction(state.db, () => {
      state.db
        .prepare(
          "INSERT INTO review_item(id,nid,state,due_date,reason,created_at) VALUES(?,?,'queued',?,?,?)",
        )
        .run(
          reviewId,
          id,
          input.dueDate ?? null,
          input.reason ?? null,
          Date.now(),
        );
    });
    reply.code(201);
    return {
      id: reviewId,
      slug: item.slug,
      title: item.title,
      dueDate: input.dueDate ?? null,
      reason: input.reason ?? null,
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/reviews/:id",
    (request, reply) => {
      const result = state.db
        .prepare(
          "UPDATE review_item SET state='removed',closed_at=? WHERE id=? AND state='queued'",
        )
        .run(Date.now(), request.params.id);
      if (result.changes !== 1)
        throw Object.assign(new Error("Queued review not found."), {
          statusCode: 404,
        });
      reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/reviews/:id/complete",
    (request, reply) => {
      const input = completionInput.parse(request.body ?? {});
      const review = state.db
        .prepare("SELECT nid FROM review_item WHERE id=? AND state='queued'")
        .get(request.params.id) as { nid: string } | undefined;
      if (!review)
        throw Object.assign(new Error("Queued review not found."), {
          statusCode: 404,
        });
      const completedAt = Date.now();
      transaction(state.db, () => {
        state.db
          .prepare(
            "UPDATE review_item SET state='completed',closed_at=? WHERE id=? AND state='queued'",
          )
          .run(completedAt, request.params.id);
        state.db
          .prepare(
            "INSERT INTO review_log(review_item_id,nid,completed_at,confidence,note) VALUES(?,?,?,?,?)",
          )
          .run(
            request.params.id,
            review.nid,
            completedAt,
            input.confidence ?? null,
            input.note ?? null,
          );
      });
      reply.code(200);
      return { id: request.params.id, completedAt };
    },
  );
}
