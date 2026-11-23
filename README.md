# Synapse

Synapse runs a local reader for an Obsidian-compatible Markdown curriculum. The implementation status records which features are available.

Install Node.js 22.18 or newer and pnpm 11. Run `pnpm install` and `pnpm dev`, then open http://127.0.0.1:5173. Development creates an isolated sample in `.local/vault`.

For a single local process, run `pnpm build` and `pnpm start` after the sample has been initialized. Open http://127.0.0.1:4317.

To read your own vault, copy `synapse.config.example.json` to `synapse.config.json`. Set `vaultPath` to the directory containing the curriculum and choose a separate `dataDir`. Keep `allowVaultWrites` false. Synapse stores SQLite state in `dataDir/state.db`. Give each vault its own data directory.

See [Development](DEVELOPMENT.md), [Testing](TESTING.md) and [Implementation status](IMPLEMENTATION_STATUS.md).
