# Synapse implementation status

## Current milestone

M5, editing and synchronization. Synapse is usable as a local vault reader. The complete F1–F24 release remains in development.

## Implemented

- M0–M1 established the independent pnpm workspace, portable sample, private fixture workflow and read-only inventory verifier. The curriculum index parses metadata, links, prerequisites, learning order, exercises and health issues.
- M2 added the local API, watcher, replayable events, stable SQLite identities and contentless search. A socket integration test covers reconnect and replay. URL stability under new duplicate basenames still needs integration.
- M3–M4 added the responsive reader, Markdown and KaTeX rendering, local search, folder/domain/Learning Path grouping, URL-filtered list, resources and practice displays, library links, and a read-only Vault Health view. The full shell, command palette and all-note browser rendering sweep are pending.
- M5 added the audited write coordinator, opt-in CodeMirror source editor with preview, guarded status and checkbox actions, conflict comparison, backups, file history, and explicit restore. Draft persistence, automatic three-way merge, the full metadata form, mirror controls and conflict-copy resolution are pending.

## Verification

- The 119-check suite passed after write routes were integrated. The independent vault snapshot reported zero changes across 227 files, including all 194 Markdown notes.
- Six Chromium checks passed across three viewport sizes. They covered search, prerequisite navigation, the absence of outbound requests during that journey, and draft preservation after a concurrent editor saves. Desktop and compact sample reader screenshots were inspected. The real vault was also opened through the read-only API, which returned Linear Regression and indexed all 194 notes.
- The first 100-round stress run passed 1,700 checks. The expanded 21-case suite then passed 2,100 checks across 100 independent rounds.
- Discovery and current PDF/URL totals differ as described in docs/ARCH-NOTES.md. The POSIX write fallback has the final check-to-rename limitation documented in DEVELOPMENT.md.
- Production build passed. Vite warned that the lazy editor chunk exceeds its default size warning threshold.

## Commits

`a7a787f` foundation, `ba04854` parser and verification, `812b092` local read server, `6f1d6e7` responsive reader, `90e7e9b` safe editing and `493fea2` editor preview and restore.

## Remaining work

Finish M5 acceptance including manual Obsidian concurrency and recovery verification. Continue with M6 repair and migration change sets, M7 timers and streaks, M8 personal notes and completion tracking, M9 attachment management and file viewers, M10 interactive graph and daily dashboard, M11 manual review and statistics, then M12–M13 full responsive, performance and accessibility acceptance.
