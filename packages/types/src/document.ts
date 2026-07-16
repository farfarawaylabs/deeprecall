import { z } from 'zod';
import { FileType } from './enums';
import { JsonValue } from './json';
import { Scope } from './scope';
import { PurgeScope } from './purge';

/** Document record as stored in D1 (source files stored in R2). */
export const Document = z.object({
  id: z.string(),
  r2_key: z.string(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  /**
   * File format derived from MIME + filename at upload time. Closed set —
   * only values we can extract text from. Null for legacy rows created
   * before this column existed.
   */
  file_type: FileType.nullable(),
  /**
   * Free-form classification tag supplied by the product (e.g., "transcript",
   * "knowledge_file", "meeting_notes"). Optional. Used for list filtering —
   * not enforced by the system and not used to drive extraction.
   */
  document_type: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * Scope the upload targeted — mirrors the scope triple on the memories
   * this document produces. At upload time at least one of user_id or
   * agent_id must be set (API validates via Scope); session_id is optional.
   */
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  session_id: z.string().nullable(),
  uploaded_at: z.string(),
  // Typed as JSON (not `unknown`) so Document stays RPC-serializable —
  // the value always originates from JSON.parse of a D1 TEXT column.
  metadata: z.record(z.string(), JsonValue).nullable(),
});
export type Document = z.infer<typeof Document>;

/** Request body for document upload (parsed from multipart form data). */
export const DocumentUploadRequest = z.object({
  /** Scoping context */
  scope: Scope,
  /** Free-form classification tag. Any string (including empty). */
  document_type: z.string().optional(),
  /** Optional description */
  description: z.string().optional(),
  /** Optional scene type hint for extraction */
  scene_type: z.string().optional(),
  /** Optional idempotency key */
  idempotency_key: z.string().optional(),
});
export type DocumentUploadRequest = z.infer<typeof DocumentUploadRequest>;

/** Response after document upload + ingestion trigger. */
export const DocumentUploadResponse = z.object({
  document_id: z.string(),
  instance_id: z.string(),
  filename: z.string().nullable(),
  size_bytes: z.number(),
  message: z.string(),
});
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponse>;

/** Response for document metadata retrieval. */
export const DocumentResponse = z.object({
  document: Document,
});
export type DocumentResponse = z.infer<typeof DocumentResponse>;

// ─── List (GET /v1/documents) ───────────────────────────────

/**
 * Query parameters for listing documents. Scope fields are optional — omit both
 * to list every document the product owns. Cursor is an opaque base64 of the
 * last row's `(uploaded_at, id)` tuple; pass it back to fetch the next page.
 */
export const DocumentListQuery = z.object({
  /** Scope filters — all optional. When none are provided, every document in the product is returned. */
  user_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  /** Filter by free-form classification tag (exact match). */
  document_type: z.string().min(1).optional(),
  /** Filter by derived file format. */
  file_type: FileType.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

export const DocumentListResponse = z.object({
  documents: z.array(Document),
  next_cursor: z.string().nullable(),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponse>;

// ─── Delete one (DELETE /v1/documents/:id) ──────────────────

/** Sync response when a single document and its extracted memories are removed. */
export const DocumentDeleteResponse = z.object({
  deleted: z.literal(true),
  document_id: z.string(),
  memories_deleted: z.number().int().nonnegative(),
  vectors_deleted: z.number().int().nonnegative(),
  audits_deleted: z.number().int().nonnegative(),
});
export type DocumentDeleteResponse = z.infer<typeof DocumentDeleteResponse>;

// ─── Purge many (DELETE /v1/documents) ──────────────────────

/**
 * Body for DELETE /v1/documents. Either `scope` (scoped purge) or
 * `confirm_product_id` (product-wide purge) must be provided — never both.
 * `confirm: true` is required for execution; `dry_run: true` returns counts
 * synchronously without scheduling a job.
 *
 * Uses the shared `PurgeScope` — user_id and/or agent_id, no session_id. A
 * session-scoped purge isn't a meaningful unit (sessions are ephemeral and
 * could mask a missing higher-level scope from the caller's perspective).
 */
export const DocumentPurgeRequest = z
  .object({
    scope: PurgeScope.optional(),
    confirm_product_id: z.string().min(1).optional(),
    confirm: z.boolean().default(false),
    dry_run: z.boolean().default(false),
  })
  .refine((r) => !!r.scope !== !!r.confirm_product_id, {
    message: 'exactly one of `scope` or `confirm_product_id` must be provided',
  });
export type DocumentPurgeRequest = z.infer<typeof DocumentPurgeRequest>;

/** Dry-run response for DELETE /v1/documents. */
export const DocumentPurgeDryRunResponse = z.object({
  dry_run: z.literal(true),
  scope: PurgeScope.nullable(),
  documents_would_delete: z.number().int().nonnegative(),
  memories_would_delete: z.number().int().nonnegative(),
});
export type DocumentPurgeDryRunResponse = z.infer<typeof DocumentPurgeDryRunResponse>;
