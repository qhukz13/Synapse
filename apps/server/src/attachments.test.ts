import { createHash } from "node:crypto";
import {
  mkdtemp,
  cp,
  mkdir,
  rm,
  readFile,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { configFrom, projectDir } from "./config";
import { createApp } from "./app";

const running: { close: () => Promise<void>; root: string }[] = [];
async function setup(extraRoot = false) {
  const root = await mkdtemp(join(tmpdir(), "synapse-attachments-"));
  await cp(
    join(projectDir, "packages/core/test/fixtures/vault"),
    join(root, "vault"),
    { recursive: true },
  );
  const outside = join(root, "approved docs");
  await mkdir(outside);
  await writeFile(join(outside, "reference.pdf"), "%PDF-1.7\nfixture bytes\n");
  await writeFile(
    join(outside, "archive.zip"),
    "not a real archive, but a download-only fixture",
  );
  const app = await createApp(
    configFrom({
      vaultPath: join(root, "vault"),
      dataDir: join(root, "state"),
      ...(extraRoot
        ? { attachments: { extraRoots: [{ id: "docs", path: outside }] } }
        : {}),
    }),
  );
  running.push({ root, close: () => app.app.close() });
  return { app, root, outside };
}
afterEach(async () => {
  for (const item of running.splice(0)) {
    await item.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

it("browses approved roots and serves a referenced file by id with ranges", async () => {
  const { app, root, outside } = await setup(true);
  const headers = { host: "127.0.0.1:4317" };
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  const roots = await app.app.inject({
    url: "/api/attachments/roots",
    headers,
  });
  expect(roots.json().map((item: { id: string }) => item.id)).toEqual([
    "vault",
    "docs",
    "managed",
  ]);
  const browse = await app.app.inject({
    url: "/api/attachments/browse?root=docs",
    headers,
  });
  expect(browse.json().items).toContainEqual(
    expect.objectContaining({ name: "reference.pdf", kind: "file" }),
  );
  expect(
    (
      await app.app.inject({
        url: "/api/attachments/browse?root=vault&path=../../",
        headers,
      })
    ).statusCode,
  ).toBe(403);
  const original = await readFile(join(outside, "reference.pdf"));
  const digest = createHash("sha256").update(original).digest("hex");
  const created = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: mutation,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "docs",
      relPath: "reference.pdf",
    },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({
    mode: "reference",
    availability: "ok",
    size: original.length,
    root_id: "docs",
  });
  const id = created.json().id as string;
  const duplicate = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: mutation,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "docs",
      relPath: "reference.pdf",
    },
  });
  expect(duplicate.statusCode).toBe(409);
  const listed = await app.app.inject({
    url: "/api/attachments?owner=machine-learning",
    headers,
  });
  expect(listed.json().map((row: { id: string }) => row.id)).toContain(id);
  const range = await app.app.inject({
    url: `/api/attachments/${id}/content`,
    headers: { ...headers, range: "bytes=0-4" },
  });
  expect(range.statusCode).toBe(206);
  expect(range.headers["content-range"]).toBe(`bytes 0-4/${original.length}`);
  expect(range.body).toBe(original.subarray(0, 5).toString());
  const archive = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: mutation,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "docs",
      relPath: "archive.zip",
    },
  });
  expect(archive.statusCode).toBe(200);
  const download = await app.app.inject({
    url: `/api/attachments/${archive.json().id}/content`,
    headers,
  });
  expect(download.headers["content-type"]).toContain(
    "application/octet-stream",
  );
  expect(download.headers["content-disposition"]).toContain("attachment;");
  expect(
    (
      await app.app.inject({
        method: "DELETE",
        url: `/api/attachments/${id}`,
        headers: mutation,
        payload: {},
      })
    ).statusCode,
  ).toBe(204);
  expect(
    createHash("sha256")
      .update(await readFile(join(outside, "reference.pdf")))
      .digest("hex"),
  ).toBe(digest);
  expect(
    (await app.app.inject({ url: `/api/attachments/${id}/content`, headers }))
      .statusCode,
  ).toBe(404);
  expect(
    await readFile(
      join(
        root,
        "vault",
        "04 - Classical Machine Learning",
        "Machine Learning.md",
      ),
      "utf8",
    ),
  ).toContain("# Machine Learning");
});

it("rejects unapproved roots and symlinked files without exposing them", async () => {
  const { app, root, outside } = await setup();
  await symlink(outside, join(root, "vault", "escaped"));
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  const browse = await app.app.inject({
    url: "/api/attachments/browse?root=vault",
    headers,
  });
  expect(browse.statusCode).toBe(200);
  expect(
    browse
      .json()
      .items.some((item: { name: string }) => item.name === "escaped"),
  ).toBe(false);
  const blockedRoot = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "home",
      relPath: "secret.pdf",
    },
  });
  expect(blockedRoot.statusCode).toBe(404);
  const blockedSymlink = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "vault",
      relPath: "escaped/reference.pdf",
    },
  });
  expect(blockedSymlink.statusCode).toBe(403);
  const cannotAddRoot = await app.app.inject({
    method: "POST",
    url: "/api/attachments",
    headers,
    payload: {
      owner: "machine-learning",
      mode: "reference",
      rootId: "vault",
      relPath: "04 - Classical Machine Learning/Machine Learning.md",
      rootPath: "/",
    },
  });
  expect(cannotAddRoot.statusCode).toBe(422);
});
