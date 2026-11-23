import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdtemp,
  cp,
  rm,
  symlink,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { configFrom, projectDir } from "./config";
import { createApp, type Context } from "./app";
import { assertRelative, safeFile } from "./vault/scanner";
let root: string, ctx: Context;
const headers = { host: "127.0.0.1:4317" };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "synapse-read-"));
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
it.each([
  "../x",
  "a/../x",
  "/tmp/x",
  "a//b",
  "a/",
  "./a",
  "a/.git/config",
  "a/.obsidian/workspace",
  "a/.trash/a",
  "a/.stversions/x",
  "node_modules/test",
  "a\\x",
  "C:/files",
  "",
  String.fromCharCode(0) + "x",
  "foo.synapse-tmp-1",
])("rejects unsafe relative path %j", (p) =>
  expect(() => assertRelative(p)).toThrow(),
);
it("serves from a root by validated file handle and refuses symlinks", async () => {
  const link = join(root, "vault", "outside");
  await symlink("/etc", link);
  await expect(
    safeFile(join(root, "vault"), "outside/passwd"),
  ).rejects.toThrow();
});
it("checks hosts and origins before handlers run", async () => {
  expect(
    (
      await ctx.app.inject({
        url: "/api/topics",
        headers: { host: "elsewhere.test" },
      })
    ).statusCode,
  ).toBe(421);
  for (const extra of [
    {},
    { "x-synapse": "1", origin: "https://elsewhere.test" },
    { origin: "http://127.0.0.1:4317" },
  ]) {
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/admin/reindex",
          headers: { ...headers, ...extra },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  }
});
it("filters and searches the curriculum and serves partial library files", async () => {
  const get = (url: string) => ctx.app.inject({ url, headers });
  expect(
    (await get("/api/topics?domain=mathematics"))
      .json()
      .every((n: { domain: string }) => n.domain === "mathematics"),
  ).toBe(true);
  expect(
    (await get("/api/search?q=Regression"))
      .json()
      .some((n: { slug: string }) => n.slug === "linear-regression"),
  ).toBe(true);
  const range = await ctx.app.inject({
    url: "/api/files/15%20-%20Notebooks/calibration.csv",
    headers: { ...headers, range: "bytes=0-3" },
  });
  expect(range.statusCode).toBe(206);
  expect(range.rawPayload).toHaveLength(4);
});
it("detects editor temp-renames and keeps the topic identity", async () => {
  const path = "04 - Classical Machine Learning/Linear Regression.md",
    f = join(root, "vault", path);
  const id = ctx.nid("linear-regression"),
    source = await readFile(f, "utf8");
  const changed = once(ctx.work.changes, "index.changed", {
    signal: AbortSignal.timeout(2500),
  });
  await writeFile(
    f + ".synapse-tmp-1",
    source.replace("status: learning", "status: understood"),
  );
  await rename(f + ".synapse-tmp-1", f);
  await changed;
  expect(ctx.topic("linear-regression").status.value).toBe("understood");
  expect(ctx.nid("linear-regression")).toBe(id);
});
