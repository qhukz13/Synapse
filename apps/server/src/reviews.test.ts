import { afterAll, beforeAll, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFrom, projectDir } from "./config";
import { createApp, type Context } from "./app";

let root: string;
let ctx: Context;
const headers = {
  host: "127.0.0.1:4317",
  origin: "http://127.0.0.1:4317",
  "x-synapse": "1",
  "content-type": "application/json",
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "synapse-reviews-"));
  await cp(
    join(projectDir, "packages/core/test/fixtures/vault"),
    join(root, "vault"),
    { recursive: true },
  );
  ctx = await createApp(
    configFrom({ vaultPath: join(root, "vault"), dataDir: join(root, "data") }),
  );
});
afterAll(async () => {
  await ctx?.app.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("queues only manually selected topics and records completed review history", async () => {
  const add = await ctx.app.inject({
    method: "POST",
    url: "/api/reviews",
    headers,
    payload: {
      slug: "machine-learning",
      dueDate: "2026-12-01",
      reason: "Revisit loss functions",
    },
  });
  expect(add.statusCode).toBe(201);
  expect(add.json()).toMatchObject({
    title: "Machine Learning",
    dueDate: "2026-12-01",
  });
  expect(
    (await ctx.app.inject({ url: "/api/reviews", headers })).json(),
  ).toHaveLength(1);
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/reviews",
        headers,
        payload: { slug: "machine-learning" },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/reviews",
        headers,
        payload: { slug: "linear-regression", dueDate: "2026-02-30" },
      })
    ).statusCode,
  ).toBe(422);
  const complete = await ctx.app.inject({
    method: "POST",
    url: `/api/reviews/${add.json().id}/complete`,
    headers,
    payload: { confidence: 3, note: "Explained it from memory." },
  });
  expect(complete.statusCode).toBe(200);
  expect(
    (await ctx.app.inject({ url: "/api/reviews", headers })).json(),
  ).toHaveLength(0);
  expect(
    (
      await ctx.app.inject({ url: "/api/reviews?history=true", headers })
    ).json(),
  ).toMatchObject([
    {
      title: "Machine Learning",
      confidence: 3,
      note: "Explained it from memory.",
    },
  ]);
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/reviews/${add.json().id}/complete`,
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
});

it("lets the learner remove a queued review without changing curriculum status", async () => {
  const originalStatus = (
    await ctx.app.inject({ url: "/api/topics/linear-regression", headers })
  ).json().status.value;
  const add = await ctx.app.inject({
    method: "POST",
    url: "/api/reviews",
    headers,
    payload: { slug: "linear-regression" },
  });
  expect(add.statusCode).toBe(201);
  const removed = await ctx.app.inject({
    method: "DELETE",
    url: `/api/reviews/${add.json().id}`,
    headers,
    payload: {},
  });
  expect(removed.statusCode).toBe(204);
  expect(
    (await ctx.app.inject({ url: "/api/reviews", headers })).json(),
  ).toHaveLength(0);
  expect(
    (
      await ctx.app.inject({ url: "/api/topics/linear-regression", headers })
    ).json().status.value,
  ).toBe(originalStatus);
});
