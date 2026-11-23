-- identity
CREATE TABLE node_identity(nid TEXT PRIMARY KEY, node_key TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, content_hash TEXT, last_status TEXT, last_category TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE node_alias(nid TEXT REFERENCES node_identity, old_key TEXT, renamed_at INTEGER, PRIMARY KEY(nid, old_key));

-- status history (append-only; current status lives in Markdown)
CREATE TABLE status_event(id INTEGER PRIMARY KEY, nid TEXT NOT NULL REFERENCES node_identity,
  from_status TEXT, to_status TEXT NOT NULL, from_category TEXT, to_category TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('frontmatter','course-checkbox')),
  origin TEXT NOT NULL CHECK(origin IN ('app','external','changeset')),
  at INTEGER NOT NULL, session_id TEXT);
CREATE INDEX status_event_nid_at ON status_event(nid, at);

-- sessions
CREATE TABLE study_session(id TEXT PRIMARY KEY, nid TEXT REFERENCES node_identity,   -- null = general study
  state TEXT NOT NULL CHECK(state IN ('running','paused','ended','discarded')),
  started_at INTEGER NOT NULL, ended_at INTEGER, last_heartbeat_at INTEGER,
  end_reason TEXT CHECK(end_reason IN ('user','heartbeat-lost','server-restart','max-duration')),
  note TEXT);
CREATE UNIQUE INDEX one_open_session ON study_session((1)) WHERE state IN ('running','paused');
CREATE TABLE session_segment(id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_session ON DELETE CASCADE,
  started_at INTEGER NOT NULL, ended_at INTEGER,                           -- UTC ms; null = open
  close_reason TEXT CHECK(close_reason IN ('pause','stop','idle','heartbeat-lost','server-restart','max-duration','trim')),
  CHECK(ended_at IS NULL OR ended_at >= started_at));
CREATE TABLE session_audit(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL,
  action TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL);

-- manual reviews (Q-07)
CREATE TABLE review_item(id TEXT PRIMARY KEY, nid TEXT NOT NULL REFERENCES node_identity,
  state TEXT NOT NULL CHECK(state IN ('queued','completed','removed')),
  due_date TEXT,                         -- 'YYYY-MM-DD' local date chosen by the user, nullable
  reason TEXT, created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE UNIQUE INDEX one_queued_review ON review_item(nid) WHERE state = 'queued';
CREATE TABLE review_log(id INTEGER PRIMARY KEY, review_item_id TEXT NOT NULL REFERENCES review_item,
  nid TEXT NOT NULL, completed_at INTEGER NOT NULL,
  confidence INTEGER CHECK(confidence BETWEEN 1 AND 3),   -- optional: 1 shaky, 2 okay, 3 solid
  note TEXT, session_id TEXT);

-- practice
CREATE TABLE exercise_progress(nid TEXT NOT NULL, fingerprint TEXT NOT NULL, section TEXT NOT NULL,
  ordinal INTEGER NOT NULL, text_snapshot TEXT NOT NULL, done_at INTEGER NOT NULL, orphaned_at INTEGER,
  PRIMARY KEY(nid, fingerprint));

-- attachments (Q-10)
CREATE TABLE attachment_blob(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT,
  stored_rel TEXT NOT NULL,              -- relative to dataDir/attachments/blobs
  created_at INTEGER NOT NULL, trashed_at INTEGER);
CREATE TABLE attachment(id TEXT PRIMARY KEY, owner_nid TEXT NOT NULL REFERENCES node_identity,
  mode TEXT NOT NULL CHECK(mode IN ('reference','managed')),
  root_id TEXT,                          -- reference: 'vault' | configured root id
  rel_path TEXT,                         -- reference: path relative to root (validated)
  blob_sha256 TEXT REFERENCES attachment_blob,           -- managed
  display_name TEXT NOT NULL, original_name TEXT, file_kind TEXT NOT NULL, mime TEXT,
  size INTEGER, sha256 TEXT,             -- reference: filled lazily, used for move detection
  availability TEXT NOT NULL DEFAULT 'ok' CHECK(availability IN ('ok','missing','relinked')),
  last_verified_at INTEGER, created_at INTEGER NOT NULL, note TEXT,
  CHECK((mode='reference' AND root_id IS NOT NULL AND rel_path IS NOT NULL AND blob_sha256 IS NULL)
     OR (mode='managed' AND blob_sha256 IS NOT NULL AND root_id IS NULL)));
CREATE UNIQUE INDEX attachment_ref_unique ON attachment(owner_nid, root_id, rel_path) WHERE mode='reference';
CREATE UNIQUE INDEX attachment_blob_unique ON attachment(owner_nid, blob_sha256) WHERE mode='managed';

-- vault health & change sets (Q-01, Q-03, Q-06)
CREATE TABLE health_dismissal(issue_id TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL, note TEXT);
CREATE TABLE change_set(id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('health-fix','python-course-migration','notes-migration')),
  title TEXT NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','applied','partially-applied','reverted','discarded')));
CREATE TABLE change_item(id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL REFERENCES change_set,
  issue_id TEXT, path TEXT NOT NULL, target_path TEXT,            -- target_path for moves
  op_json TEXT NOT NULL,                 -- PlannedOp (see §10)
  evidence_json TEXT NOT NULL,           -- why each proposed value is justified
  base_hash TEXT NOT NULL, after_hash TEXT, backup_path TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('proposed','applied','failed','skipped-conflict','reverted','revert-conflict')),
  error TEXT, applied_at INTEGER, reverted_at INTEGER);

-- misc
CREATE TABLE resource_state(resource_id TEXT PRIMARY KEY, done_at INTEGER, last_opened_at INTEGER, position TEXT);
CREATE TABLE focus(nid TEXT PRIMARY KEY, pinned_at INTEGER NOT NULL, sort INTEGER);
CREATE TABLE activity(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, nid TEXT, payload TEXT);
CREATE TABLE link_preview(url TEXT PRIMARY KEY, title TEXT, description TEXT, site TEXT, image TEXT,
  fetched_at INTEGER, status INTEGER, error TEXT);
CREATE TABLE write_journal(id TEXT PRIMARY KEY, path TEXT NOT NULL, target_path TEXT, base_hash TEXT,
  new_hash TEXT NOT NULL, tmp_path TEXT, backup_path TEXT, op TEXT NOT NULL, change_item_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','committed','rolled_back','failed')),
  created_at INTEGER NOT NULL, finished_at INTEGER, error TEXT);
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- contentless: stores the inverted index only, never note text (Q-03)
CREATE VIRTUAL TABLE fts USING fts5(title, headings, body, content='', contentless_delete=1, tokenize='trigram');
CREATE TABLE fts_map(rowid INTEGER PRIMARY KEY, nid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL);

-- Keep the map and full-text index indivisible. The trigger also isolates FTS5's
-- internal 64-bit segment rowids from callers reading SQLite's last insert id.
CREATE TRIGGER fts_map_remove AFTER DELETE ON fts_map BEGIN
  DELETE FROM fts WHERE rowid = OLD.rowid;
END;
