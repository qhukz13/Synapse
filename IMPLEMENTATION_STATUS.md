# Synapse implementation status

Current milestone: M1, curriculum indexing.

## Foundation

Independent main repository and loopback workspace established. React/Vite shell, Fastify health endpoint, strict TypeScript, validated configuration, isolated sample, Vitest and Playwright are present. Node 26 SQLite capability and the contrast adjustment are recorded in docs/ARCH-NOTES.md.

## In progress

Validate the read-only index and the discovery baseline. The first full scan parsed 194 notes and all 166 frontmatters with zero disk changes. The PDF and URL totals differ from the planning baseline and are under investigation.

M2 through M13 remain open. No real-vault editing has been enabled. The write-safety gate must pass before write-enabled feature development. Results, commits and next steps will be updated at each checkpoint.

M0 checks: 5 configuration tests passed and the Vite → Fastify smoke journey passed at 1440×900, 1024×768 and 390×844. Chromium was supplied via SYNAPSE_CHROMIUM.

## M1 verification

All 194 Markdown documents and 166 metadata blocks parsed. The full index contains 162 prerequisite edges (145 curriculum edges), 12 stages and 16 checkbox-backed statuses. The health inventory agrees with discovery, including 3 folder links, 6 body-only prerequisite warnings, 33 redundant edges and 8 later prerequisites. The initial integrity scan compared 227 files with zero creations, changes or removals. See docs/ARCH-NOTES.md for the PDF and bare-URL baseline differences.

The core suite passed 33 checks with 99.59% line coverage. Foundation commit a7a787f reached origin/main. M2 is in progress. Full-fidelity file writes, change sets and activity features are still pending.
