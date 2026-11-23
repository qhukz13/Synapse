# Engineering decisions

- Node 26.8.2 on Linux x64 uses ABI 147. The better-sqlite3 13.2.0 release URL for this ABI returned 404. The approved node:sqlite fallback provides SQLite 3.53.4. A contentless-delete FTS5 table with the trigram tokenizer was created successfully in memory.
- Local plans and discovery material contain personal paths and study history. The original documents stay in the checkout and are excluded from public Git. Portable fixture Markdown was written for this repository. Real-file golden tests use separately prepared private copies.
- Development starts with an isolated copy of the portable course. Vault writes default off. Application state and vault directories must be disjoint.
- Two muted-text colors in the interface specification miss its contrast target. The dark theme uses #858b95 and the light theme uses #676c75. Run `node scripts/contrast.mjs` to check all token combinations.

The local verification run found eight eligible PDFs. Discovery reported nine. Its 279 distinct Markdown-link destinations exclude the one documented bare URL, which GFM also indexes. The current resource inventory therefore has 280 distinct destinations. The verifier reports these observations separately from the original baseline.
