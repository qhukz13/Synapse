# Development

`pnpm dev` starts Fastify on loopback port 4317 and Vite on port 5173. Vite proxies the API and event stream. The pure parser and curriculum model live under `packages/core`.

The example config defaults to an isolated sample vault and private state under `.local`. Use `SYNAPSE_CONFIG` to select a separate config file for an integration run. Vault paths and application data directories must be disjoint.

SQLite creates a backup under `dataDir/backups/database` before upgrading existing state. Stop Synapse before restoring or replacing database files. Keep a copy of the current data directory, including SQLite sidecars, before attempting recovery. The reader has no vault restore interface yet.
