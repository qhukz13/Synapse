import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { prepareSample } from "./sample.mjs";
const stable = process.argv.includes("--stable");
const testDirectory = stable
  ? await mkdtemp(join(tmpdir(), "synapse-browser-"))
  : null;
if (testDirectory) {
  const vaultPath = join(testDirectory, "vault");
  await cp(
    new URL("../packages/core/test/fixtures/vault/", import.meta.url),
    vaultPath,
    { recursive: true },
  );
  process.env.SYNAPSE_CONFIG = join(testDirectory, "config.json");
  await writeFile(
    process.env.SYNAPSE_CONFIG,
    JSON.stringify({
      vaultPath,
      dataDir: join(testDirectory, "state"),
      allowVaultWrites: true,
    }),
  );
} else {
  await prepareSample();
}
process.env.SYNAPSE_DEV = "1";
const children = [
  spawn(
    "node",
    [
      "node_modules/tsx/dist/cli.mjs",
      ...(stable ? [] : ["watch"]),
      "apps/server/src/main.ts",
    ],
    { stdio: "inherit" },
  ),
  spawn(
    "node",
    ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
    { stdio: "inherit" },
  ),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* exited */
    }
  }
  process.exitCode = code;
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.once("exit", (code) => {
          stop(code ?? 1);
          resolve();
        });
      }),
  ),
);
if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
