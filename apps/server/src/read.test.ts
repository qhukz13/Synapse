import { get } from "node:http";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdtemp,
  cp,
  mkdir,
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
it("persists topic-linked study sessions through the local API", async () => {
  const writeHeaders = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  const started = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: writeHeaders,
    payload: { topicSlug: "linear-regression" },
  });
  expect(started.statusCode).toBe(200);
  const session = started.json();
  expect(session.nid).toBe(ctx.nid("linear-regression"));
  expect(
    (await ctx.app.inject({ url: "/api/sessions/current", headers })).json().id,
  ).toBe(session.id);
  expect(
    (await ctx.app.inject({ url: "/api/stats/study", headers })).json()
      .timeZone,
  ).toBeTruthy();
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/pause`,
        headers: writeHeaders,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/stop`,
        headers: writeHeaders,
        payload: { note: "Review gradient descent next." },
      })
    ).statusCode,
  ).toBe(200);
  const history = (
    await ctx.app.inject({ url: "/api/sessions", headers })
  ).json() as { id: string; note: string | null }[];
  expect(history.find((item) => item.id === session.id)?.note).toBe(
    "Review gradient descent next.",
  );
  const focus = (
    await ctx.app.inject({ url: "/api/stats/study", headers })
  ).json().focusByDomain as { domain: string; ms: number }[];
  expect(focus).toContainEqual(
    expect.objectContaining({ domain: "machine-learning" }),
  );
});
it("returns deterministic recommendations and persists resource completion", async () => {
  const first = (
    await ctx.app.inject({ url: "/api/recommendations", headers })
  ).json();
  const second = (
    await ctx.app.inject({ url: "/api/recommendations", headers })
  ).json();
  expect(first.all.map((item: { slug: string }) => item.slug)).toEqual(
    second.all.map((item: { slug: string }) => item.slug),
  );
  expect(first.all.length).toBeGreaterThan(0);
  const resources = (
    await ctx.app.inject({ url: "/api/resources", headers })
  ).json() as { id: string; doneAt: number | null }[];
  expect(resources.length).toBeGreaterThan(0);
  const target = resources[0]!;
  const writeHeaders = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: `/api/resources/${target.id}/state`,
        headers: writeHeaders,
        payload: { done: true },
      })
    ).statusCode,
  ).toBe(200);
  const after = (
    await ctx.app.inject({ url: "/api/resources", headers })
  ).json() as { id: string; doneAt: number | null }[];
  expect(after.find((item) => item.id === target.id)?.doneAt).toBeTruthy();
  await ctx.app.inject({
    method: "POST",
    url: `/api/resources/${target.id}/state`,
    headers: writeHeaders,
    payload: { done: false },
  });
});
it("allows session history corrections to shorten or remove recorded segments only", async () => {
  const writeHeaders = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  const started = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: writeHeaders,
    payload: {},
  });
  const session = started.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ctx.app.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/stop`,
    headers: writeHeaders,
    payload: {},
  });
  const record = (await ctx.app.inject({ url: "/api/sessions", headers }))
    .json()
    .find((item: { id: string }) => item.id === session.id);
  const segment = record.segments[0] as {
    id: number;
    started_at: number;
    ended_at: number;
  };
  const trim = (body: object) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/segments/${segment.id}/trim`,
      headers: writeHeaders,
      payload: body,
    });
  expect((await trim({ startAt: segment.started_at + 1 })).statusCode).toBe(
    200,
  );
  expect((await trim({ startAt: segment.started_at })).statusCode).toBe(422);
  expect((await trim({ delete: true })).statusCode).toBe(422);
  expect((await trim({ delete: true, confirm: true })).statusCode).toBe(200);
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

it("replays missed index events when a client reconnects", async () => {
  const origin = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const connect = (cursor?: string) =>
    new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      const request = get(
        origin + "/api/events",
        {
          headers: {
            ...headers,
            ...(cursor ? { "Last-Event-ID": cursor } : {}),
          },
          signal: AbortSignal.timeout(3000),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(Error("Unexpected event status " + response.statusCode));
            return;
          }
          resolve(Readable.toWeb(response) as ReadableStream<Uint8Array>);
        },
      );
      request.once("error", reject);
    });
  const first = (await connect()).getReader();
  const decoder = new TextDecoder();
  async function readUntil(stream: typeof first, expected: string) {
    let result = "";
    while (!result.includes(expected)) {
      const chunk = await stream.read();
      if (chunk.done) throw Error("Event stream closed before " + expected);
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result;
  }
  const initial = await readUntil(first, "event: index.changed");
  await first.cancel();
  const cursor = /id: (\d+)/.exec(initial)![1]!;
  const path = join(root, "vault", "Late arrival.md");
  await writeFile(path, "# Late arrival");
  await ctx.work.refresh();
  const stream = (await connect(cursor)).getReader();
  try {
    const events = await readUntil(stream, "Late arrival.md");
    expect(events).toContain("event: index.changed");
  } finally {
    await stream.cancel();
  }
});

it("requires opt-in, saves an authorized edit and exposes stale source without overwriting", async () => {
  const url = "/api/topics/linear-regression/source";
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
  };
  const read = (context: Context) => context.app.inject({ url, headers });
  const save = (context: Context, text: string, baseHash: string) =>
    context.app.inject({
      url,
      method: "PUT",
      headers: mutation,
      payload: { text, baseHash },
    });
  const original = (await read(ctx)).json();
  expect(
    (await save(ctx, original.text + "\nBlocked edit", original.hash))
      .statusCode,
  ).toBe(403);
  const writable = await createApp(
    configFrom({
      vaultPath: join(root, "vault"),
      dataDir: join(root, "write-state"),
      allowVaultWrites: true,
    }),
  );
  try {
    const changed = original.text + "\nAn authorized edit.\n";
    expect((await save(writable, changed, original.hash)).statusCode).toBe(200);
    const stale = await save(
      writable,
      original.text + "\nA stale draft.",
      original.hash,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details.theirs).toBe(changed);
    expect((await read(writable)).json().text).toBe(changed);
  } finally {
    await writable.app.close();
  }
});

it("returns the entire original Markdown body and the vault connection details", async () => {
  await ctx.work.refresh();
  const file = await readFile(
    join(
      root,
      "vault",
      "04 - Classical Machine Learning",
      "Linear Regression.md",
    ),
    "utf8",
  );
  const response = await ctx.app.inject({
    url: "/api/topics/linear-regression",
    headers,
  });
  const note = response.json();
  expect(response.statusCode).toBe(200);
  expect(note.body).toBe(file.slice(note.fm.bodyStart));
  expect(note.fm.meta).toMatchObject({
    type: "concept",
    domain: "machine-learning",
    prerequisites: ["Dot Products"],
  });
  const summary = await ctx.app.inject({ url: "/api/index/summary", headers });
  expect(summary.json()).toMatchObject({
    vaultPath: join(root, "vault"),
    writeEnabled: false,
  });
});

it("creates and saves personal notes through guarded Markdown writes", async () => {
  const writable = await createApp(
    configFrom({
      vaultPath: join(root, "vault"),
      dataDir: join(root, "notes-state"),
      allowVaultWrites: true,
    }),
  );
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
  };
  try {
    const created = await writable.app.inject({
      method: "POST",
      url: "/api/personal-notes",
      headers: mutation,
      payload: {
        title: "Gradient Descent - learning rate intuition",
        scope: "topic",
        aboutSlug: "vectors",
      },
    });
    expect(created.statusCode).toBe(200);
    const result = created.json();
    expect(result.path).toBe(
      "Personal Notes/Topics/Vectors/Gradient Descent - learning rate intuition.md",
    );
    const original = await readFile(join(root, "vault", result.path), "utf8");
    expect(original).toContain("type: note\nscope: topic");
    expect(original).toContain('"[[Vectors]]"');
    expect(original).toContain("created:");
    expect(
      (
        await writable.app.inject({
          url: "/api/personal-notes?aboutSlug=vectors",
          headers,
        })
      )
        .json()
        .map((item: { slug: string }) => item.slug),
    ).toContain(result.slug);

    const collision = await writable.app.inject({
      method: "POST",
      url: "/api/personal-notes",
      headers: mutation,
      payload: {
        title: "Gradient Descent - learning rate intuition",
        scope: "topic",
        aboutSlug: "linear-regression",
      },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().code).toBe("NAME_COLLISION");

    const detail = await writable.app.inject({
      url: `/api/personal-notes/${result.slug}`,
      headers,
    });
    const note = detail.json();
    const privateSentence = "A private sentence that belongs only in Markdown.";
    const text = `${note.text}\n${privateSentence}\n`;
    expect(
      (
        await writable.app.inject({
          method: "PUT",
          url: `/api/personal-notes/${result.slug}`,
          headers: mutation,
          payload: { baseHash: note.hash, text },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await writable.app.inject({
          method: "PUT",
          url: `/api/personal-notes/${result.slug}`,
          headers: mutation,
          payload: { baseHash: note.hash, text: note.text },
        })
      ).statusCode,
    ).toBe(409);
    const saved = await readFile(join(root, "vault", result.path), "utf8");
    expect(saved).toContain(privateSentence);
    expect(
      (
        await writable.app.inject({
          url: `/api/personal-notes?q=${encodeURIComponent(privateSentence)}`,
          headers,
        })
      )
        .json()
        .find((item: { slug: string }) => item.slug === result.slug).snippet,
    ).toContain(privateSentence);
    const dbBytes = await readFile(join(root, "notes-state", "state.db"));
    expect(dbBytes.includes(Buffer.from(privateSentence))).toBe(false);
  } finally {
    await writable.app.close();
  }
});

it("appends, renames with link review, moves scopes and trashes personal notes", async () => {
  const vault = join(root, "note-lifecycle-vault");
  await cp(join(projectDir, "packages/core/test/fixtures/vault"), vault, {
    recursive: true,
  });
  const writable = await createApp(
    configFrom({
      vaultPath: vault,
      dataDir: join(root, "note-lifecycle-state"),
      allowVaultWrites: true,
    }),
  );
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
    "content-type": "application/json",
  };
  try {
    const created = await writable.app.inject({
      method: "POST",
      url: "/api/personal-notes",
      headers: mutation,
      payload: { title: "Lifecycle scratchpad", scope: "general" },
    });
    expect(created.statusCode).toBe(200);
    const initial = created.json();
    const capture = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${initial.slug}/append`,
      headers: mutation,
      payload: {
        baseHash: initial.hash,
        text: "A dated quick capture stays in the Markdown note.",
      },
    });
    expect(capture.statusCode).toBe(200);
    let detail = (
      await writable.app.inject({
        url: `/api/personal-notes/${initial.slug}`,
        headers,
      })
    ).json();
    expect(detail.text).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(detail.text).toContain(
      "A dated quick capture stays in the Markdown note.",
    );

    const pythonPath = join(vault, "01 - Foundations/Python.md");
    const pythonText = await readFile(pythonPath, "utf8");
    await writeFile(
      pythonPath,
      `${pythonText}\nSee [[Lifecycle scratchpad]].\n`,
    );
    await writable.work.refresh();
    const blockedRename = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${initial.slug}/rename`,
      headers: mutation,
      payload: {
        baseHash: detail.hash,
        title: "Lifecycle archive",
        confirmInbound: false,
      },
    });
    expect(blockedRename.statusCode).toBe(409);
    expect(blockedRename.json()).toMatchObject({
      code: "INBOUND_LINKS",
      details: { inbound: [expect.objectContaining({ title: "Python" })] },
    });
    const renamed = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${initial.slug}/rename`,
      headers: mutation,
      payload: {
        baseHash: detail.hash,
        title: "Lifecycle archive",
        confirmInbound: true,
      },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().path).toBe(
      "Personal Notes/General/Lifecycle archive.md",
    );
    expect(await readFile(pythonPath, "utf8")).toContain(
      "[[Lifecycle scratchpad]]",
    );

    detail = (
      await writable.app.inject({
        url: `/api/personal-notes/${renamed.json().slug}`,
        headers,
      })
    ).json();
    const collisionPath = join(
      vault,
      "Personal Notes/Topics/Vectors/Lifecycle archive.md",
    );
    await mkdir(join(vault, "Personal Notes/Topics/Vectors"), {
      recursive: true,
    });
    await writeFile(collisionPath, "# Existing note\n");
    const refusedMove = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${detail.slug}/move`,
      headers: mutation,
      payload: {
        baseHash: detail.hash,
        scope: "topic",
        aboutSlug: "vectors",
      },
    });
    expect(refusedMove.statusCode).toBe(409);
    expect(refusedMove.json().code).toBe("NAME_COLLISION");
    detail = (
      await writable.app.inject({
        url: `/api/personal-notes/${detail.slug}`,
        headers,
      })
    ).json();
    expect(detail.scope).toBe("general");
    expect(detail.text).not.toContain("scope: topic");
    await rm(collisionPath);
    const moved = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${detail.slug}/move`,
      headers: mutation,
      payload: {
        baseHash: detail.hash,
        scope: "topic",
        aboutSlug: "vectors",
      },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().path).toBe(
      "Personal Notes/Topics/Vectors/Lifecycle archive.md",
    );
    detail = (
      await writable.app.inject({
        url: `/api/personal-notes/${moved.json().slug}`,
        headers,
      })
    ).json();
    expect(detail.scope).toBe("topic");
    expect(detail.text).toContain("scope: topic");
    expect(detail.text).toContain('"[[Vectors]]"');

    const trashed = await writable.app.inject({
      method: "POST",
      url: `/api/personal-notes/${detail.slug}/trash`,
      headers: mutation,
      payload: { baseHash: detail.hash },
    });
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().path).toMatch(/^\.trash\//);
    await expect(readFile(join(vault, detail.path))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readFile(join(vault, trashed.json().path))).toString("utf8"),
    ).toContain("A dated quick capture stays in the Markdown note.");
  } finally {
    await writable.app.close();
  }
});

it("tracks app exercises, preserves reworded ticks and keeps removed items as orphans", async () => {
  const vault = join(root, "vault");
  const path = "01 - Foundations/Python.md";
  const file = join(vault, path);
  const original = await readFile(file, "utf8");
  const writable = await createApp(
    configFrom({
      vaultPath: vault,
      dataDir: join(root, "practice-state"),
      allowVaultWrites: true,
    }),
  );
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
  };
  try {
    const seeded = original.replace(
      "## Exercises\n",
      "## Exercises\n\n- [ ] Verify the sensor example.\n",
    );
    await writeFile(file, seeded);
    await writable.work.refresh();
    const initial = (
      await writable.app.inject({ url: "/api/practice/python", headers })
    ).json();
    const first = initial.exercises.find((item: { text: string }) =>
      item.text.startsWith("Predict the output"),
    );
    expect(first.done).toBe(false);
    expect(first.source).toBe("app");
    const toggle = await writable.app.inject({
      method: "POST",
      url: "/api/practice/python",
      headers: mutation,
      payload: { fingerprint: first.fingerprint, done: true },
    });
    expect(toggle.statusCode).toBe(200);
    expect(
      toggle
        .json()
        .exercises.find(
          (item: { fingerprint: string }) =>
            item.fingerprint === first.fingerprint,
        ).done,
    ).toBe(true);

    const checkbox = initial.exercises.find(
      (item: { text: string }) => item.text === "Verify the sensor example.",
    );
    expect(checkbox.source).toBe("markdown");
    const topic = (
      await writable.app.inject({ url: "/api/topics/python", headers })
    ).json();
    const checkboxWrite = await writable.app.inject({
      method: "POST",
      url: "/api/topics/python/checkbox",
      headers: mutation,
      payload: {
        baseHash: topic.hash,
        offset: checkbox.offset,
        checked: true,
        expectedChecked: false,
      },
    });
    expect(checkboxWrite.statusCode).toBe(200);
    expect(await readFile(file, "utf8")).toContain(
      "- [x] Verify the sensor example.",
    );

    const reworded = seeded.replace(
      "Predict the output for reading 0 before running the function.",
      "Predict the result for reading 0 before running the function.",
    );
    await writeFile(file, reworded);
    await writable.work.refresh();
    const afterRewrite = (
      await writable.app.inject({ url: "/api/practice/python", headers })
    ).json();
    const carried = afterRewrite.exercises.find((item: { text: string }) =>
      item.text.startsWith("Predict the result"),
    );
    expect(carried.done).toBe(true);
    expect(afterRewrite.orphans).toHaveLength(0);

    await writeFile(
      file,
      reworded.replace(
        "Predict the result for reading 0 before running the function.\n",
        "",
      ),
    );
    await writable.work.refresh();
    const afterRemoval = (
      await writable.app.inject({ url: "/api/practice/python", headers })
    ).json();
    expect(afterRemoval.orphans[0].text_snapshot).toContain(
      "Predict the result",
    );
  } finally {
    await writeFile(file, original);
    await writable.work.refresh();
    await writable.app.close();
  }
});

it("previews course migration read-only and applies and reverts the selected file in an isolated vault", async () => {
  const url = "/api/vault-health/proposals?kind=python-course-migration";
  const payloadFor = (item: {
    issueId: string;
    baseHash: string;
    afterHash: string;
  }) => ({
    kind: "python-course-migration",
    confirm: true,
    items: [
      {
        issueId: item.issueId,
        baseHash: item.baseHash,
        afterHash: item.afterHash,
      },
    ],
  });
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
  };
  const previews = (await ctx.app.inject({ url, headers })).json();
  expect(previews.length).toBeGreaterThan(0);
  expect(
    (
      await ctx.app.inject({
        url: "/api/changesets/apply",
        method: "POST",
        headers: mutation,
        payload: payloadFor(previews[0]),
      })
    ).statusCode,
  ).toBe(403);
  const vault = join(root, "migration-vault");
  await cp(join(projectDir, "packages/core/test/fixtures/vault"), vault, {
    recursive: true,
  });
  const writable = await createApp(
    configFrom({
      vaultPath: vault,
      dataDir: join(root, "migration-state"),
      allowVaultWrites: true,
    }),
  );
  try {
    const proposals = (await writable.app.inject({ url, headers })).json();
    const proposal = proposals.find((item: { path: string }) =>
      item.path.endsWith("01 - Test a Prediction.md"),
    );
    expect(proposal.after).toContain("type: lesson");
    expect(proposal.after.endsWith(proposal.before)).toBe(true);
    const file = join(vault, proposal.path);
    expect(await readFile(file, "utf8")).toBe(proposal.before);
    const stale = await writable.app.inject({
      url: "/api/changesets/apply",
      method: "POST",
      headers: mutation,
      payload: payloadFor({ ...proposal, baseHash: "a".repeat(64) }),
    });
    expect(stale.statusCode).toBe(409);
    const applied = await writable.app.inject({
      url: "/api/changesets/apply",
      method: "POST",
      headers: mutation,
      payload: payloadFor(proposal),
    });
    expect(applied.statusCode).toBe(200);
    const result = applied.json()[0];
    expect(result.state).toBe("applied");
    expect(await readFile(file, "utf8")).toBe(proposal.after);
    const reverted = await writable.app.inject({
      url: "/api/changesets/items/" + result.id + "/revert",
      method: "POST",
      headers: mutation,
      payload: { confirm: true },
    });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()[0].state).toBe("reverted");
    expect(await readFile(file, "utf8")).toBe(proposal.before);
    const repeated = "See [[02 - Mathematics]] and [[02 - Mathematics]].\n";
    const repeatedFile = join(vault, "Repeated folder link.md");
    await writeFile(repeatedFile, repeated);
    await writable.work.refresh();
    const health = await writable.app.inject({
      url: "/api/vault-health/proposals?kind=health-fix",
      headers,
    });
    const partial = health
      .json()
      .find(
        (item: { path: string }) => item.path === "Repeated folder link.md",
      );
    expect(partial).toBeDefined();
    const failed = await writable.app.inject({
      url: "/api/changesets/apply",
      method: "POST",
      headers: mutation,
      payload: { ...payloadFor(partial), kind: "health-fix" },
    });
    expect(failed.statusCode).toBe(200);
    expect(
      failed
        .json()
        .find(
          (item: { path: string }) => item.path === "Repeated folder link.md",
        )?.state,
    ).toBe("failed");
    expect(await readFile(repeatedFile, "utf8")).toBe(repeated);
  } finally {
    await writable.app.close();
  }
});

it("uses declared entry notes and body links as repair evidence", async () => {
  const folderLink =
    "# Repair example\n\nSee [[02 - Mathematics|math stage]].\n";
  await writeFile(join(root, "vault", "Repair example.md"), folderLink);
  const file = join(
    root,
    "vault",
    "04 - Classical Machine Learning",
    "Linear Regression.md",
  );
  const original = await readFile(file, "utf8");
  await writeFile(file, original + "\n\n## Prerequisites\n- [[Vectors]]\n");
  await ctx.work.refresh();
  try {
    const response = await ctx.app.inject({
      url: "/api/vault-health/proposals?kind=health-fix",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const proposals = response.json() as { path: string; after: string }[];
    expect(
      proposals.find((item) => item.path === "Repair example.md")?.after,
    ).toBe(
      folderLink.replace(
        "[[02 - Mathematics|math stage]]",
        "[[Mathematics|math stage]]",
      ),
    );
    expect(
      proposals.find((item) => item.path.endsWith("Linear Regression.md"))
        ?.after,
    ).toContain("prerequisites: [Dot Products, Vectors]");
    expect(
      await readFile(join(root, "vault", "Repair example.md"), "utf8"),
    ).toBe(folderLink);
  } finally {
    await writeFile(file, original);
  }
});

it("moves and restores a selected legacy note without changing bytes or its identity", async () => {
  const vault = join(root, "legacy-vault");
  const dataDir = join(root, "legacy-state");
  await cp(join(projectDir, "packages/core/test/fixtures/vault"), vault, {
    recursive: true,
  });
  const { mkdir } = await import("node:fs/promises");
  const legacy = "99 - Inbox/Mathematics - Notes/Vectors - notes.md";
  await mkdir(join(vault, "99 - Inbox/Mathematics - Notes"), {
    recursive: true,
  });
  const original = "---\ntype: note\n---\n# Original note\n";
  await writeFile(join(vault, legacy), original);
  const config = configFrom({
    vaultPath: vault,
    dataDir,
    allowVaultWrites: true,
  });
  let writable = await createApp(config);
  const mutation = {
    ...headers,
    origin: "http://127.0.0.1:4317",
    "x-synapse": "1",
  };
  const request = async (url: string, payload: object) =>
    writable.app.inject({ url, method: "POST", headers: mutation, payload });
  try {
    const id = writable.nid("vectors-notes");
    const preview = (
      await writable.app.inject({
        url: "/api/vault-health/proposals?kind=notes-migration",
        headers,
      })
    ).json()[0];
    expect(preview.targetPath).toBe(
      "Personal Notes/Topics/Vectors/Vectors - notes.md",
    );
    expect(await readFile(join(vault, legacy), "utf8")).toBe(original);
    const applied = await request("/api/changesets/apply", {
      kind: "notes-migration",
      confirm: true,
      items: [
        {
          issueId: preview.issueId,
          baseHash: preview.baseHash,
          afterHash: preview.afterHash,
        },
      ],
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()[0].state).toBe("applied");
    const itemId = applied.json()[0].id;
    await expect(readFile(join(vault, legacy))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(vault, preview.targetPath), "utf8")).toBe(
      original,
    );
    await writable.app.close();
    writable = await createApp(config);
    expect(writable.nid("vectors-notes")).toBe(id);
    expect(
      (await writable.app.inject({ url: "/api/changesets", headers })).json()[0]
        .state,
    ).toBe("applied");
    const restored = await request(
      "/api/changesets/items/" + itemId + "/revert",
      { confirm: true },
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json()[0].state).toBe("reverted");
    expect(writable.nid("vectors-notes")).toBe(id);
    expect(await readFile(join(vault, legacy), "utf8")).toBe(original);
  } finally {
    await writable.app.close();
  }
});
