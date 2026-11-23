# Synapse implementation status

## Current milestone

M10, Dashboard foundation (prioritized before further M7/M8 work). The first usable dashboard and persisted resource completion states are implemented; the full dashboard and wider F1–F24 release remain in development.

## Implemented

- M0–M1 established the independent pnpm workspace, portable sample, private fixture workflow and read-only inventory verifier. The curriculum index parses metadata, links, prerequisites, learning order, exercises and health issues.
- M2 added the local API, watcher, replayable events, stable SQLite identities and contentless search. A socket integration test covers reconnect and replay. URL stability under new duplicate basenames still needs integration.
- M3–M4 added the responsive reader, Markdown and KaTeX rendering, local search, folder/domain/Learning Path grouping, URL-filtered list, resources and practice displays, library links, and a read-only Vault Health view. The full shell, command palette and all-note browser rendering sweep are pending.
- M5 added the audited write coordinator, opt-in CodeMirror source editor with preview, guarded status and checkbox actions, conflict comparison, backups, file history, and explicit restore. Draft persistence, automatic three-way merge, the full metadata form, mirror controls and conflict-copy resolution are pending.
- M7 adds persistent sessions with server-side lifecycle controls, topic association, heartbeat loss and restart recovery, idle auto-pause and bounded restore, an active-time cap, audit history, timezone-aware totals and streaks, a global timer, and a session history view.
- M10 dashboard foundation: `/` is now a data-backed dashboard; the curriculum tree lives at `/roadmap/tree`. It shows real continue/next suggestions and reasons, status-derived stage progress, measured study/streak data, recent activity, recently modified vault files and health errors. The Resources page lists deduplicated curriculum links, topic associations and a persisted completed/uncompleted toggle. Deterministic recommendation rules are in the pure core and never exclude topics because of prerequisites.

## Vault connection and Properties

The reader shows the active vault path and access mode. Each topic displays its parsed frontmatter, including custom fields, and passes the entire original Markdown body to the renderer. The application checkout may use an ignored read-only real-vault configuration. Browser tests use an independently seeded temporary vault. Structured property editing beyond status is pending.

## Verification

- The 119-check suite passed after write routes were integrated. The independent vault snapshot reported zero changes across 227 files, including all 194 Markdown notes.
- Six Chromium checks passed across three viewport sizes. They covered search, prerequisite navigation, the absence of outbound requests during that journey, and draft preservation after a concurrent editor saves. Desktop and compact sample reader screenshots were inspected. The real vault was also opened through the read-only API, which returned Linear Regression and indexed all 194 notes.
- The first 100-round stress run passed 1,700 checks. The expanded 21-case suite then passed 2,100 checks across 100 independent rounds.
- Discovery and current PDF/URL totals differ as described in docs/ARCH-NOTES.md. The POSIX write fallback has the final check-to-rename limitation documented in DEVELOPMENT.md.
- Production build passed. Vite warned that the lazy editor chunk exceeds its default size warning threshold.
- Dashboard verification: 137 unit/integration tests pass; TypeScript, ESLint and production build pass. The 18-check full Chromium suite passed across desktop, medium and compact widths, including dashboard recommendations and persisted resource completion. The real vault verifier reports 227 files checked and zero created, removed or modified.

## Commits

`a7a787f` foundation, `ba04854` parser and verification, `812b092` local read server, `6f1d6e7` responsive reader, `90e7e9b` safe editing and `493fea2` editor preview and restore.

## Remaining work

Finish M5 acceptance including manual Obsidian concurrency and recovery verification. M7 still needs segment correction controls, the end-of-session note sheet, streak progress indicator, activity and focus rollups, and wider progress acceptance. The M10 dashboard is its first vertical slice: manual review panels, richer progress rollups, checkpoints and recommendation refinements remain. Continue with M8 personal notes and exercise completion, M9 attachment management and file viewers, the M10 interactive graph and full dashboard, M11 manual reviews and fuller analytics, then M12–M13 responsive, performance, accessibility and release acceptance.

## M6 repair and migration checkpoint

Vault Health now previews folder-link repairs, prerequisites already documented in the body, and Python Course metadata additions. The real vault produced nine repair previews and 25 course previews. Each item shows its evidence and the original and proposed contents. Apply requires individual file selection, explicit batch confirmation, a writable configuration, and matching hashes for the source and preview. The journal records the backups and supplies the original bytes for undo. A stale approval before apply requires a fresh preview. A conflicting change after the batch starts is recorded against the affected item.

The isolated suite passed apply and byte-exact undo, stale approvals, and read-only previews. The remaining M6 work includes additional repair families, editable legacy-note destinations, and broader post-apply acceptance coverage.

Post-apply validation compares the indexed file with the reviewed result and checks that the targeted issue is gone. An isolated regression verifies rollback when a repair leaves its issue present. A newer intervening edit is reported for review.

Legacy note reorganization now proposes the destination while retaining the original filename. The real vault returns 18 read-only previews. Isolated tests verify byte-exact move and undo, journal reconciliation after restart, and stable SQLite identity.

Course migration previews now let the user supply optional difficulty and importance. Changing either field clears that file’s approval until a fresh preview is generated. The selected values are labeled as user-entered and included in the hash that is checked on apply.

## M7 timer and streak checkpoint

Session totals derive from explicit active segments. The server monitors heartbeats, records lost-heartbeat time conservatively, auto-pauses idle intervals at the approved backdated point, and permits a one-time restore bounded by the auto-pause time. Restart closes running time at the last heartbeat. The four-hour cap applies to active time. Streak dates use the IANA zone captured in private SQLite state (or the explicitly configured zone); UTC segments are split at local midnight and unioned to avoid double-counting.

The timer polls for another tab’s state. Web Locks elect one heartbeat leader and release the lock on tab close or session state change; waiting tabs retry for handover. BroadcastChannel shares user activity so the leader can see interaction in another tab. A localStorage lease is used when Web Locks are unavailable. Server time remains authoritative. Chromium E2E verifies one heartbeat leader and handover when the leader tab closes.
