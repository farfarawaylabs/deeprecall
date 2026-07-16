import type {
  Memory,
  MemoryStatus,
  SourceType,
  AuditAction,
  AuditTrigger,
  Document,
  FileType,
  JsonValue,
} from '@deeprecall/types';

// ─── Pagination ──────────────────────────────────────────────

export interface PaginationParams {
  cursor?: string;
  limit: number;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
}

// ─── Memory Repository ───────────────────────────────────────

export interface MemoryCreateInput {
  id: string;
  content: string;
  episode: string | null;
  type: Memory['type'];
  status: Memory['status'];
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  source_actor: string;
  source_type: Memory['source_type'];
  source_channel: Memory['source_channel'];
  confidence: number;
  document_id: string | null;
  validity_start: string | null;
  validity_end: string | null;
  observed_at: string;
  tags: string[] | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
}

/** Scope match keys for data-layer queries (at least one required). */
export interface ScopeKeys {
  user_id?: string;
  agent_id?: string;
}

export interface MemoryListFilters {
  user_id?: string;
  agent_id?: string;
  status?: MemoryStatus;
  type?: Memory['type'];
  /** ISO 8601 lower bound on `created_at` (ingestion time), inclusive. */
  since?: string;
}

export interface IMemoryRepository {
  create(input: MemoryCreateInput): Promise<Memory>;
  getById(id: string): Promise<Memory | null>;
  listByScope(
    filters: MemoryListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Memory>>;
  updateStatus(id: string, status: MemoryStatus, superseded_by?: string): Promise<void>;
  /** FTS5 keyword search, relaxed scope match (null on memory passes). */
  search(query: string, scope: ScopeKeys, limit: number): Promise<Memory[]>;
  getByIds(ids: string[]): Promise<Memory[]>;
  /** Strict delete — null on memory does NOT match. Requires at least one key. */
  deleteByScope(scope: ScopeKeys): Promise<number>;
  /** Strict rate-limit count. Requires at least one key. */
  countCreatedSince(scope: ScopeKeys, since: string): Promise<number>;
  updateConfidenceAndSourceType(
    id: string,
    confidence: number,
    source_type: SourceType,
  ): Promise<void>;
  /** Find active memories not updated since a given date, for confidence decay. */
  findStaleMemories(notUpdatedSince: string, limit: number): Promise<Memory[]>;
  /** Update only the confidence of a memory. */
  updateConfidence(id: string, confidence: number): Promise<void>;
  /**
   * Find active fact memories for profile consolidation.
   * Strict match with disjoint-pool rule:
   *   - user-scoped run ({ user_id }): WHERE user_id = ?
   *   - agent-scoped run ({ agent_id }): WHERE agent_id = ? AND user_id IS NULL
   */
  findFactsForProfile(scope: ScopeKeys, minConfidence: number, limit: number): Promise<Memory[]>;
  /** Get all distinct user_ids that have active memories. */
  getActiveUserIds(limit: number): Promise<string[]>;
  /** Get all distinct agent_ids that have active standalone-agent memories (user_id IS NULL). */
  getActiveAgentIds(limit: number): Promise<string[]>;
  /**
   * List memory IDs matching a strict scope (null on memory does NOT match).
   * Lightweight vs listByScope which returns full Memory rows. Used by the
   * scoped purge job to collect vector/audit cleanup targets.
   */
  listIdsByScopeStrict(scope: ScopeKeys, limit: number): Promise<string[]>;
  /**
   * List all memory IDs in the product regardless of status. Used by the
   * product-wide purge job. Bounded by `limit` — callers must size it to
   * accommodate expected product volume.
   */
  listAllIds(limit: number): Promise<string[]>;
  /** Delete every memory in the product. Returns rows affected. */
  deleteAll(): Promise<number>;
  /**
   * List IDs of memories extracted from a given document. Used by the single-
   * document delete flow and document purge to cascade cleanup. Bounded by
   * `limit`; callers must size to chunk the work if a doc has more memories.
   */
  listIdsByDocumentId(documentId: string, limit: number): Promise<string[]>;
  /**
   * Delete every memory linked to a given document. Returns rows affected.
   * Caller is responsible for cleaning up vectors/audits first.
   */
  deleteByDocumentId(documentId: string): Promise<number>;
  /**
   * List IDs of every memory linked to any document (document_id IS NOT NULL).
   * Used by the document-wide purge to decide which memories to cascade.
   */
  listIdsWithAnyDocument(limit: number): Promise<string[]>;
  /**
   * Delete every memory tied to any document. Returns rows affected.
   * Single SQL — used by the product-wide documents purge after vector
   * and audit cleanup.
   */
  deleteAllWithDocument(): Promise<number>;
}

// ─── Audit Repository ────────────────────────────────────────

export interface AuditEntry {
  id: string;
  memory_id: string;
  action: AuditAction;
  reason: string | null;
  old_value: string | null;
  new_value: string | null;
  triggered_by: AuditTrigger;
  created_at: string;
}

export interface IAuditRepository {
  log(
    action: AuditAction,
    memoryId: string,
    reason: string | null,
    oldValue: unknown | null,
    newValue: unknown | null,
    triggeredBy: AuditTrigger,
  ): Promise<void>;
  getByMemoryId(memoryId: string): Promise<AuditEntry[]>;
  /** Relaxed scope match — null on memory passes. At least one key required. */
  listRecent(scope: ScopeKeys, limit: number): Promise<AuditEntry[]>;
  deleteByMemoryIds(memoryIds: string[]): Promise<number>;
}

// ─── Idempotency Repository ─────────────────────────────────

export interface IIdempotencyRepository {
  check(key: string): Promise<string | null>;
  store(key: string, response: string, ttlHours: number): Promise<void>;
  cleanup(): Promise<number>;
}

// ─── Dead Letter Repository ─────────────────────────────────

export interface DeadLetterEntry {
  id: string;
  queue_name: string;
  payload: string;
  error: string | null;
  attempts: number;
  first_failed_at: string;
  last_failed_at: string;
}

export interface IDeadLetterRepository {
  create(entry: DeadLetterEntry): Promise<void>;
  getById(id: string): Promise<DeadLetterEntry | null>;
  list(limit: number): Promise<DeadLetterEntry[]>;
  count(): Promise<number>;
  deleteById(id: string): Promise<void>;
}

// ─── Document Repository ────────────────────────────────────

export interface DocumentCreateInput {
  id: string;
  r2_key: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  /** Closed set — server-derived from MIME + filename. */
  file_type: FileType | null;
  /** Free-form classification tag. */
  document_type: string | null;
  description: string | null;
  /** Scope the upload targeted — at least one of user_id or agent_id must be non-null. */
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  metadata: Record<string, JsonValue> | null;
}

export interface DocumentUpdateInput {
  r2_key?: string;
  filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  file_type?: FileType | null;
  document_type?: string | null;
  description?: string | null;
  user_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  metadata?: Record<string, JsonValue> | null;
}

export interface DocumentListFilters {
  /**
   * Scope filters — all optional. When none are provided, every document
   * in the product is returned (admin-style inventory). Match semantics
   * mirror the memory list path: relaxed (null on the row passes).
   */
  user_id?: string;
  agent_id?: string;
  session_id?: string;
  /** Exact match on free-form classification tag. */
  document_type?: string;
  /** Exact match on derived file format. */
  file_type?: FileType;
}

/**
 * R2 cleanup handle — `id` points at the D1 row and `r2_key` at the
 * object body. Both must be deleted together; callers use these pairs
 * to drive cascade deletes without re-querying the table.
 */
export interface DocumentCleanupRef {
  id: string;
  r2_key: string;
}

export interface IDocumentRepository {
  create(input: DocumentCreateInput): Promise<Document>;
  getById(id: string): Promise<Document | null>;
  deleteById(id: string): Promise<void>;
  /**
   * Cursor-paginated list with optional filters. Scope filters use relaxed
   * matching (null on the row passes), mirroring memory list semantics.
   * Cursor encodes `(uploaded_at, id)` so order remains stable when rows
   * share a timestamp.
   */
  list(
    filters: DocumentListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Document>>;
  /** Partial update; undefined fields are left untouched. Returns the updated row. */
  update(id: string, input: DocumentUpdateInput): Promise<Document>;
  /**
   * Collect {id, r2_key} pairs for every document matching a strict scope
   * (null on the row does NOT match). Mirrors memory purge semantics —
   * destructive ops refuse to sweep up null-scoped rows a scoped caller
   * didn't explicitly own. Requires at least one of user_id / agent_id.
   */
  listCleanupRefsByScope(scope: ScopeKeys, limit: number): Promise<DocumentCleanupRef[]>;
  /** Collect {id, r2_key} pairs for every document in the product DB. */
  listAllCleanupRefs(limit: number): Promise<DocumentCleanupRef[]>;
  /** Delete every document row matching a strict scope. Returns rows affected. */
  deleteByScope(scope: ScopeKeys): Promise<number>;
  /** Delete every document row in the product. Returns rows affected. */
  deleteAll(): Promise<number>;
}
