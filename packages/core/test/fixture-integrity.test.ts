import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function fixtureFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(fixtures, dir), {
    withFileTypes: true,
  });
  const names: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...(await fixtureFiles(relative)));
    } else {
      expect(entry.isFile(), relative).toBe(true);
      names.push(relative);
    }
  }
  return names;
}

test("portable example and edge cases match their byte checksums", async () => {
  const expected = JSON.parse(
    await readFile(path.join(fixtures, "checksums.json"), "utf8"),
  ) as Record<string, string>;
  const paths = [
    ...(await fixtureFiles("vault")),
    ...(await fixtureFiles("edge-cases")),
  ].sort();
  expect(paths).toEqual(Object.keys(expected).sort());
  for (const file of paths) {
    const bytes = await readFile(path.join(fixtures, file));
    expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(
      expected[file],
    );
  }
});
