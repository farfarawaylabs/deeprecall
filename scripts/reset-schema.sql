-- Reset a product DB to the clean post-cleanup baseline.
-- Drops every table/trigger/index and reapplies INITIAL_SCHEMA_SQL.
-- Safe to run on a fresh DB too (all DROPs are IF EXISTS).
--
-- Use only for pre-launch resets. Destroys all data.

-- Triggers must drop before their referenced virtual table
DROP TRIGGER IF EXISTS memories_au;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_ai;

DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memory_audit;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS artifacts;       -- pre-rename legacy
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS db_metadata;

-- ─── New baseline schema ──────────────────────────────────

CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  episode         TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  user_id         TEXT,
  agent_id        TEXT,
  session_id      TEXT,
  source_actor    TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_channel  TEXT,
  confidence      REAL DEFAULT 0.5,
  document_id     TEXT,
  validity_start  TEXT,
  validity_end    TEXT,
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  superseded_by   TEXT REFERENCES memories(id),
  tags            TEXT,
  subject         TEXT,
  predicate       TEXT,
  object          TEXT
);

CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_user_status ON memories(user_id, status);
CREATE INDEX idx_memories_agent_id ON memories(agent_id);
CREATE INDEX idx_memories_agent_status ON memories(agent_id, status);
CREATE INDEX idx_memories_created_at ON memories(created_at);
CREATE INDEX idx_memories_validity_end ON memories(validity_end);
CREATE INDEX idx_memories_document_id ON memories(document_id);

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  r2_key          TEXT NOT NULL,
  filename        TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  file_type       TEXT,
  document_type   TEXT,
  description     TEXT,
  user_id         TEXT,
  agent_id        TEXT,
  session_id      TEXT,
  uploaded_at     TEXT NOT NULL,
  metadata        TEXT
);

CREATE INDEX idx_documents_file_type ON documents(file_type);
CREATE INDEX idx_documents_document_type ON documents(document_type);
CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_documents_agent_id ON documents(agent_id);
CREATE INDEX idx_documents_session_id ON documents(session_id);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  episode,
  subject,
  object,
  content=memories,
  content_rowid=rowid
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, episode, subject, object)
  VALUES (new.rowid, new.content, new.episode, new.subject, new.object);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, episode, subject, object)
  VALUES ('delete', old.rowid, old.content, old.episode, old.subject, old.object);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, episode, subject, object)
  VALUES ('delete', old.rowid, old.content, old.episode, old.subject, old.object);
  INSERT INTO memories_fts(rowid, content, episode, subject, object)
  VALUES (new.rowid, new.content, new.episode, new.subject, new.object);
END;

CREATE TABLE memory_audit (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  reason          TEXT,
  old_value       TEXT,
  new_value       TEXT,
  triggered_by    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_audit_memory_id ON memory_audit(memory_id);
CREATE INDEX idx_audit_created_at ON memory_audit(created_at);

CREATE TABLE db_metadata (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

INSERT INTO db_metadata (key, value) VALUES ('schema_version', '4');

CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  response        TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE dead_letters (
  id              TEXT PRIMARY KEY,
  queue_name      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  error           TEXT,
  attempts        INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at  TEXT NOT NULL
);
