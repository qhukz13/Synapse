import { spawn } from "node:child_process";
import { prepareSample } from "./sample.mjs";
await prepareSample();
const children = [
  spawn(
    "node",
    ["node_modules/tsx/dist/cli.mjs", "watch", "apps/server/src/main.ts"],
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
for (const c of children) c.on("exit", (code) => stop(code ?? 1));
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
