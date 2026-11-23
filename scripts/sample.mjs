import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
export async function prepareSample() {
  const local = fileURLToPath(new URL("../.local/", import.meta.url));
  const dest = join(local, "vault");
  await mkdir(local, { recursive: true });
  try {
    await stat(dest);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(join(local, "sample-"));
  try {
    await cp(
      new URL("../packages/core/test/fixtures/vault/", import.meta.url),
      staging,
      { recursive: true },
    );
    await rename(staging, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
