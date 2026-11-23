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

## Reader checkpoint

The loopback read API, watcher and event stream are integrated. SQLite identity and contentless search are live. The reader displays Markdown, advisory prerequisites, resources and practice material. The browser shell also includes a folder-based curriculum view, full-text search, library links and a read-only health list. The current verifier matches the reconciled inventory and confirmed 227 files unchanged.

The read server is committed as 812b092. The remaining M2 check is browser verification of event replay. M3–M4 still need the complete shell, Learning Path ordering, list filters, command palette and the full-vault rendering sweep. M5 patchers and the coordinator are under isolated testing. No application route invokes the coordinator yet. M6–M13 remain open.

The next integration steps are to finish the reader acceptance gaps, verify the write stress run, and route explicitly authorized editor and status actions through the coordinator.

## Editing checkpoint

Current milestone is M5. The read-only server, renderer and browser reader are committed through 6f1d6e7. The reader now also offers Learning Path, folder and domain grouping, a URL-filtered curriculum list, and Ctrl/Cmd+K search navigation. A real socket test verifies event replay.

The opt-in CodeMirror editor and frontmatter status form call the audited coordinator. Source conflicts show the original, current disk version and retained draft. The write API exposes history, restore and real checkbox actions. Outstanding M5 UX includes persisted drafts, three-way merge, richer metadata edits, the course checkbox status control, history and sync-conflict resolution screens, and the manual Obsidian concurrency check. Recovery and atomic publication behavior are documented in DEVELOPMENT.md.

The current suite passed 119 checks. The first 100-round write run passed 1,700 checks. The expanded 21-case suite passed once and is undergoing its own 100-round run. Browser search and prerequisite navigation passed at three viewport sizes before the editing controls were added. The full release acceptance suite and M6–M13 features remain pending.
