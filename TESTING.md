# Testing

- `pnpm typecheck`, `pnpm lint` and `pnpm test` check the workspace.
- `pnpm exec playwright install chromium` prepares the browser. `pnpm test:e2e` runs the reader journey at three viewport sizes. Set `SYNAPSE_CHROMIUM` to use an existing Chromium executable.
- `pnpm verify:real-vault --vault /path/to/vault` reads the original curriculum and compares before and after checksums and modification times. Use `--inventory-only` for a different curriculum.
- Use synthetic fixtures or temporary copies for write tests. Private fixture copies belong under the ignored `.local` directory.
- `node scripts/stress-writes.mjs` repeats the isolated write coordinator suite 100 times. Cases cover stale drafts, external replacements, authorization, one-file serialization, moves, crash recovery and exact restore.

The read API integration suite exercises evidence-based folder-link and prerequisite previews, the read-only approval guard, stale approval rejection, and byte-exact course migration undo in a temporary vault.

The integration suite also verifies that a selected legacy note keeps its bytes and stable identity when moved, reopened after restart, and restored.
