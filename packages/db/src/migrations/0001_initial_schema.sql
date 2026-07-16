-- Deep Recall — Initial Schema
-- All tables for the memory system.
-- Note: Uses lowercase fts5 (D1 is case-sensitive for virtual table modules).
--
-- Enum-valued columns are plain TEXT. Validation lives in @deeprecall/types
-- (Zod) and in TypeScript union types at the DL boundary — no CHECK
-- constraints, since SQLite cannot drop them and we want enums to evolve.
--
-- Versioning note: this file is migration 0001 in wrangler's numbering, but
-- it records schema_version '4' in db_metadata — it is the BASELINE that
-- consolidated pre-launch migrations 1-4 into a single file (the originals
-- were removed - no live database exists below v4). Future migrations start
-- at 0002 / schema_version 5.
--
-- This file is the single source of truth for the initial schema. The
-- INITIAL_SCHEMA_SQL constant in ../schema.ts must stay byte-identical
-- (enforced by test/schema.test.ts) — it exists because Workers cannot
-- read .sql files at runtime and the management worker applies this
-- schema over the D1 REST API when onboarding a product.

-- Primary memory records
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  episode         TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',

  -- Scoping (product_id is implicit — each product has its own DB)
  user_id         TEXT,
  agent_id        TEXT,
  session_id      TEXT,

  -- Provenance
  source_actor    TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_channel  TEXT,
  confidence      REAL DEFAULT 0.5,

  -- Document reference
  document_id     TEXT,

  -- Lifecycle
  validity_start  TEXT,
  validity_end    TEXT,
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  superseded_by   TEXT REFERENCES memories(id),

  -- Tags (JSON array)
  tags            TEXT,

  -- Relationships (V2 graph support)
  subject         TEXT,
  predicate       TEXT,
  object          TEXT
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent_status ON memories(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_validity_end ON memories(validity_end);
CREATE INDEX IF NOT EXISTS idx_memories_document_id ON memories(document_id);

-- Source documents stored in R2.
--   file_type:     closed set (FileType in @deeprecall/types), server-derived from MIME.
--   document_type: free-form classification tag supplied by the product.
--   user_id / agent_id / session_id: scope the upload targeted. Mirrors the
--     scope columns on memories — a document uploaded under scope X produces
--     memories under scope X, so the document row preserves the same triple
--     so it can be filtered/purged by the same dimensions. At upload time at
--     least one of user_id / agent_id is required (enforced in the API).
CREATE TABLE IF NOT EXISTS documents (
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

CREATE INDEX IF NOT EXISTS idx_documents_file_type ON documents(file_type);
CREATE INDEX IF NOT EXISTS idx_documents_document_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_agent_id ON documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id);

-- Full-text search index (lowercase fts5 — D1 requirement)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  episode,
  subject,
  object,
  content=memories,
  content_rowid=rowid
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, episode, subject, object)
  VALUES (new.rowid, new.content, new.episode, new.subject, new.object);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, episode, subject, object)
  VALUES ('delete', old.rowid, old.content, old.episode, old.subject, old.object);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, episode, subject, object)
  VALUES ('delete', old.rowid, old.content, old.episode, old.subject, old.object);
  INSERT INTO memories_fts(rowid, content, episode, subject, object)
  VALUES (new.rowid, new.content, new.episode, new.subject, new.object);
END;

-- Append-only audit log
CREATE TABLE IF NOT EXISTS memory_audit (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  reason          TEXT,
  old_value       TEXT,
  new_value       TEXT,
  triggered_by    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_memory_id ON memory_audit(memory_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON memory_audit(created_at);

-- Database metadata (tracks schema version for migrations)
CREATE TABLE IF NOT EXISTS db_metadata (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

INSERT OR IGNORE INTO db_metadata (key, value) VALUES ('schema_version', '4');

-- Idempotency keys (TTL-managed, cleaned by expiry sweep)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  response        TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- Dead letter records for failed consolidation jobs
CREATE TABLE IF NOT EXISTS dead_letters (
  id              TEXT PRIMARY KEY,
  queue_name      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  error           TEXT,
  attempts        INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at  TEXT NOT NULL
);
