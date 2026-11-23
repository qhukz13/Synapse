import { spawnSync } from "node:child_process";

// Each test allocates fresh vault and database directories inside os.tmpdir().
// Run the complete integration suite in 100 independent rounds.
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "apps/server/src/vault/writes.test.ts",
    "--reporter=dot",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, SYNAPSE_WRITE_TEST_ROUNDS: "100" },
  },
);
process.exitCode = run.status ?? 1;
