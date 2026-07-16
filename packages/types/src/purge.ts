import { z } from 'zod';

// ─── Purge Scope ────────────────────────────────────────────

/**
 * Scope for a scoped purge. At least one of user_id/agent_id is required.
 * Unlike Scope in scope.ts, session_id is intentionally omitted — sessions
 * are too granular to be a meaningful purge unit and could mask a missing
 * user/agent scope from the caller's perspective.
 */
export const PurgeScope = z
  .object({
    user_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
  })
  .refine((s) => !!s.user_id || !!s.agent_id, {
    message: 'purge scope must include at least one of user_id or agent_id',
    path: ['user_id'],
  });
export type PurgeScope = z.infer<typeof PurgeScope>;

// ─── Public Request Schemas ─────────────────────────────────

/**
 * POST /v1/memories/purge — delete memories matching a user/agent scope.
 *
 * `confirm: true` is required for non-dry-run execution to defend against
 * accidental invocations.
 */
export const PurgeRequest = z.object({
  scope: PurgeScope,
  confirm: z.boolean().default(false),
  dry_run: z.boolean().default(false),
});
export type PurgeRequest = z.infer<typeof PurgeRequest>;

/**
 * POST /v1/memories/purge-all — delete every memory the calling product owns.
 *
 * `confirm_product_id` must equal the API-key-derived product_id. Forces the
 * caller to name the product explicitly so a misconfigured client can't
 * accidentally nuke the wrong tenant's data.
 *
 * `include_documents` (default `false`) additionally wipes every document row
 * and R2 blob. Opt-in so integrators who expected the old memories-only
 * behavior keep getting it.
 */
export const PurgeAllRequest = z.object({
  confirm_product_id: z.string().min(1),
  confirm: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  include_documents: z.boolean().default(false),
});
export type PurgeAllRequest = z.infer<typeof PurgeAllRequest>;

// ─── Queue Message ──────────────────────────────────────────

export const PurgeMessageType = z.enum([
  'purge_scoped',
  'purge_product',
  'purge_documents_scoped',
  'purge_documents_all',
]);
export type PurgeMessageType = z.infer<typeof PurgeMessageType>;

/**
 * Queue payload dispatched from memory-api to the consolidation worker.
 *
 * Kept separate from ConsolidationMessage — purge is deletion, consolidation
 * is reorganization. Both ride the same queue; the consumer dispatches by
 * message shape (discriminated on `kind: "purge"`).
 */
export const PurgeMessage = z.object({
  /** Discriminator distinguishing this from ConsolidationMessage payloads. */
  kind: z.literal('purge'),
  type: PurgeMessageType,
  job_id: z.string().min(1),
  product_id: z.string().min(1),
  /** Required for scoped variants (purge_scoped, purge_documents_scoped). */
  scope: PurgeScope.optional(),
  /**
   * Only meaningful for `purge_product`. When true, the consolidation
   * worker also wipes documents + R2 blobs after the memory cascade.
   * Defaults false so existing integrators keep memory-only purges
   * unless they explicitly opt in to document deletion.
   */
  include_documents: z.boolean().optional(),
  created_at: z.string(),
});
export type PurgeMessage = z.infer<typeof PurgeMessage>;

// ─── Job Status (persisted in KV) ───────────────────────────

export const PurgeJobStatusValue = z.enum(['pending', 'processing', 'completed', 'failed']);
export type PurgeJobStatusValue = z.infer<typeof PurgeJobStatusValue>;

export const PurgeJobStatus = z.object({
  job_id: z.string(),
  product_id: z.string(),
  type: PurgeMessageType,
  status: PurgeJobStatusValue,
  scope: PurgeScope.nullable(),
  memories_deleted: z.number().int().nonnegative(),
  vectors_deleted: z.number().int().nonnegative(),
  audits_deleted: z.number().int().nonnegative(),
  /** Documents removed — non-zero only for document-purge jobs and purge_product. */
  documents_deleted: z.number().int().nonnegative().default(0),
  /** R2 object bodies removed alongside the document rows. */
  r2_blobs_deleted: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type PurgeJobStatus = z.infer<typeof PurgeJobStatus>;

// ─── Public Response Shapes ─────────────────────────────────

/** Response for an async purge (202 Accepted). */
export const PurgeAcceptedResponse = z.object({
  job_id: z.string(),
  status: PurgeJobStatusValue,
  type: PurgeMessageType,
  status_url: z.string(),
});
export type PurgeAcceptedResponse = z.infer<typeof PurgeAcceptedResponse>;

/** Response for a dry-run purge (synchronous; no job created). */
export const PurgeDryRunResponse = z.object({
  dry_run: z.literal(true),
  type: PurgeMessageType,
  scope: PurgeScope.nullable(),
  memories_would_delete: z.number().int().nonnegative(),
});
export type PurgeDryRunResponse = z.infer<typeof PurgeDryRunResponse>;
