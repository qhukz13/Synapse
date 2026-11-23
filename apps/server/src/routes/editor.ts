import { z } from "zod";
import { confirmTransition, vocabulary } from "@synapse/core/status";
import type { Context } from "../app";
import { WriteCoordinator, WriteError } from "../vault/writes";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(8 * 1024 * 1024);

export function registerEditor(ctx: Context, writer: WriteCoordinator) {
  const { app, topic, work, config } = ctx;
  app.put<{ Params: { slug: string } }>(
    "/api/topics/:slug/source",
    async (request) => {
      const note = topic(request.params.slug);
      const { baseHash, text: source } = z
        .object({ baseHash: hash, text })
        .strict()
        .parse(request.body);
      return writer.write({
        trigger: "editor",
        path: note.path,
        baseHash,
        op: { type: "replaceFile", text: source },
      });
    },
  );
  app.patch<{ Params: { slug: string } }>(
    "/api/topics/:slug/meta",
    async (request) => {
      const note = topic(request.params.slug);
      const body = z
        .object({
          baseHash: hash,
          set: z.object({ status: z.string() }).strict(),
          expect: z.object({ status: z.string() }).strict(),
          confirm: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
      if (note.status.source !== "frontmatter")
        throw new WriteError(
          409,
          "NOT_ALLOWED",
          "This topic does not store status in frontmatter.",
        );
      const value = body.set.status;
      if (!vocabulary(note.kind).includes(value))
        throw new WriteError(
          422,
          "VALIDATION",
          "This status is outside the topic vocabulary.",
        );
      if (
        note.kind === "project" &&
        confirmTransition(note.status.value, value) &&
        !body.confirm
      )
        throw new WriteError(
          409,
          "NOT_ALLOWED",
          "Confirm this project status transition.",
        );
      return writer.write({
        trigger: "metadata",
        path: note.path,
        baseHash: body.baseHash,
        op: {
          type: "setScalar",
          key: "status",
          value,
          expect: body.expect.status,
        },
      });
    },
  );
  app.post<{ Params: { slug: string } }>(
    "/api/topics/:slug/checkbox",
    async (request) => {
      const note = topic(request.params.slug);
      const body = z
        .object({
          baseHash: hash,
          offset: z.number().int().nonnegative(),
          checked: z.boolean(),
          expectedChecked: z.boolean(),
        })
        .strict()
        .parse(request.body);
      const coursework =
        note.status.source === "course-checkbox" &&
        note.status.offset === body.offset;
      const exercise = note.exercises.some(
        (item) => item.offset === body.offset,
      );
      if (!coursework && !exercise)
        throw new WriteError(
          422,
          "VALIDATION",
          "No tracked checkbox exists at this location.",
        );
      const path = coursework ? config.courseHomeNote : note.path;
      if (!work.scan.files.some((file) => file.path === path))
        throw new WriteError(
          404,
          "NOT_FOUND",
          "The checkbox file is unavailable.",
        );
      const { baseHash, ...values } = body;
      return writer.write({
        trigger: "checkbox",
        path,
        baseHash,
        op: { type: "toggleCheckbox", ...values },
      });
    },
  );
  app.get<{ Params: { slug: string } }>(
    "/api/topics/:slug/history",
    (request) => writer.history(topic(request.params.slug).path),
  );
  app.get<{ Params: { slug: string; backupId: string } }>(
    "/api/topics/:slug/history/:backupId",
    (request) => ({
      text: writer.version(
        topic(request.params.slug).path,
        request.params.backupId,
      ),
    }),
  );
  app.post<{ Params: { slug: string } }>(
    "/api/topics/:slug/restore",
    (request) => {
      const input = z
        .object({
          baseHash: hash,
          backupId: z.uuid(),
          confirm: z.literal(true),
        })
        .strict()
        .parse(request.body);
      return writer.restore(
        topic(request.params.slug).path,
        input.backupId,
        input.baseHash,
      );
    },
  );
}
