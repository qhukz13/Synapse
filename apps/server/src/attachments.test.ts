import { createHash } from "node:crypto";
import {
  mkdtemp,
  cp,
  mkdir,
  rm,
  readFile,
  writeFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { configFrom, projectDir } from "./config";
import { createApp } from "./app";

const running: { close: () => Promise<void>; root: string }[] = [];
async function setup(
  options: { extraRoot?: boolean; maxUploadBytes?: number } = {},
) {
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
  const attachmentConfig = {
    ...(options.extraRoot
      ? { extraRoots: [{ id: "docs", path: outside }] }
      : {}),
    ...(options.maxUploadBytes
      ? { maxUploadBytes: options.maxUploadBytes }
      : {}),
  };
  const app = await createApp(
    configFrom({
      vaultPath: join(root, "vault"),
      dataDir: join(root, "state"),
      ...(Object.keys(attachmentConfig).length
        ? { attachments: attachmentConfig }
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
function multipart(
  filename: string,
  content: string | Buffer,
  boundary: string,
) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    typeof content === "string" ? Buffer.from(content) : content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

it("browses approved roots and serves a referenced file by id with ranges", async () => {
  const { app, root, outside } = await setup({ extraRoot: true });
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

it("streams managed uploads, deduplicates content and retains shared blobs", async () => {
  const { app, root } = await setup();
  const boundary = "synapse-fixture-boundary";
  const content = "same private managed bytes";
  const payload = multipart("capture.txt", content, boundary);
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  const upload = async (owner: string) =>
    app.app.inject({
      method: "POST",
      url: `/api/attachments/upload?owner=${owner}`,
      headers,
      payload,
    });
  const first = await upload("machine-learning");
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    mode: "managed",
    availability: "ok",
    size: Buffer.byteLength(content),
  });
  const second = await upload("linear-regression");
  expect(second.statusCode).toBe(200);
  expect(second.json().sha256).toBe(first.json().sha256);
  const blobCount = app.state.db
    .prepare("SELECT count(*) AS count FROM attachment_blob")
    .get() as { count: number };
  expect(blobCount.count).toBe(1);
  const firstContent = await app.app.inject({
    url: `/api/attachments/${first.json().id}/content`,
    headers,
  });
  expect(firstContent.body).toBe(content);
  const duplicateOwner = await upload("machine-learning");
  expect(duplicateOwner.statusCode).toBe(409);
  const remove = (id: string) =>
    app.app.inject({
      method: "DELETE",
      url: `/api/attachments/${id}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
  expect((await remove(first.json().id)).statusCode).toBe(204);
  expect(
    (
      await app.app.inject({
        url: `/api/attachments/${second.json().id}/content`,
        headers,
      })
    ).body,
  ).toBe(content);
  expect((await remove(second.json().id)).statusCode).toBe(204);
  const blob = app.state.db
    .prepare("SELECT stored_rel,trashed_at FROM attachment_blob WHERE sha256=?")
    .get(first.json().sha256) as { stored_rel: string; trashed_at: number };
  expect(blob.trashed_at).toBeGreaterThan(0);
  expect(await readFile(join(root, "state", blob.stored_rel), "utf8")).toBe(
    content,
  );
});

it("cleans up files rejected by the configured upload size limit", async () => {
  const { app, root } = await setup({ maxUploadBytes: 4 });
  const boundary = "limited-fixture-boundary";
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  const response = await app.app.inject({
    method: "POST",
    url: "/api/attachments/upload?owner=machine-learning",
    headers,
    payload: multipart("too-large.txt", "this exceeds the cap", boundary),
  });
  expect(response.statusCode).toBe(413);
  expect(
    (
      app.state.db
        .prepare("SELECT count(*) AS count FROM attachment_blob")
        .get() as { count: number }
    ).count,
  ).toBe(0);
  expect(
    (await readdir(join(root, "state", "attachments", "tmp")).catch(() => []))
      .length,
  ).toBe(0);
});

it("streams uploads larger than the default JSON body limit", async () => {
  const { app } = await setup();
  const boundary = "large-fixture-boundary";
  const headers = {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  const response = await app.app.inject({
    method: "POST",
    url: "/api/attachments/upload?owner=machine-learning",
    headers,
    payload: multipart(
      "large.txt",
      Buffer.alloc(9 * 1024 * 1024, 97),
      boundary,
    ),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().size).toBe(9 * 1024 * 1024);
});
