import { z } from 'zod';
import { Scope } from './scope';
import { Memory } from './memory';
import { SourceChannel, SceneType } from './enums';

// ─── Ingestion ───────────────────────────────────────────────

export const IngestionRequest = z.object({
  /** Content to extract memories from (conversation turns, text, etc.) */
  content: z.string().min(1),
  /** Scoping context for the memories */
  scope: Scope,
  /** Source channel of the content */
  source_channel: SourceChannel.default('chat'),
  /** Scene type hint — if omitted, auto-classified */
  scene_type: SceneType.optional(),
  /** Optional idempotency key to prevent duplicate processing */
  idempotency_key: z.string().optional(),
  /** Optional document ID if content comes from a document */
  document_id: z.string().optional(),
  /** Optional ISO timestamp of when the content originally occurred (e.g. the
   * conversation session time). Extraction anchors relative dates ("last week")
   * against this instead of the ingestion time. */
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});
export type IngestionRequest = z.infer<typeof IngestionRequest>;

export const IngestionResponse = z.object({
  /** Workflow instance ID for tracking */
  instance_id: z.string(),
  /** Status of the workflow */
  status: z.enum(['queued', 'running', 'complete', 'errored']),
  /** Message for the caller */
  message: z.string(),
});
export type IngestionResponse = z.infer<typeof IngestionResponse>;

// ─── Query ───────────────────────────────────────────────────

export const RetrievalMode = z.enum(['recall', 'full_briefing', 'foresight', 'profile']);
export type RetrievalMode = z.infer<typeof RetrievalMode>;

export const QueryRequest = z.object({
  /** The query text to search for relevant memories */
  query: z.string().min(1),
  /** Scoping context */
  scope: Scope,
  /** Retrieval mode */
  mode: RetrievalMode.default('recall'),
  /**
   * Max results to return. Default 30: the dominant consumer is an LLM
   * agent grounding its own prompt, and measured quality keeps improving
   * up to ~30 memories while retrieval latency is flat in top_k (the
   * funnel fetches/reranks the same candidate pool regardless). Pass a
   * smaller top_k when showing results directly to a human.
   */
  top_k: z.number().int().min(1).max(50).default(30),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const ScoredMemory = z.object({
  memory: Memory,
  score: z.number(),
});
export type ScoredMemory = z.infer<typeof ScoredMemory>;

export const QueryResponse = z.object({
  memories: z.array(ScoredMemory),
  total: z.number(),
  mode: RetrievalMode,
});
export type QueryResponse = z.infer<typeof QueryResponse>;

// ─── Answer ──────────────────────────────────────────────────

export const AnswerRequest = z.object({
  /** The question to answer using the product's memories */
  question: z.string().min(1),
  /** Scoping context */
  scope: Scope,
  /** Retrieval mode used to gather grounding memories */
  mode: RetrievalMode.default('recall'),
  /** How many memories to retrieve as grounding context. Defaults wider
   * than /v1/query: this endpoint already pays for an LLM call, so the
   * marginal cost of richer grounding (~1K extra input tokens, no added
   * retrieval latency) buys measurably better answers on multi-hop and
   * open-ended questions. The answer model ignores irrelevant grounding. */
  top_k: z.number().int().min(1).max(50).default(30),
  /** Optional cap on generated answer tokens. Omit to use the endpoint's default
   * (a generous budget for Anthropic answer models, or the provider's own default
   * for OpenAI/Google) — grounded answers are short, so neither truncates a normal
   * answer. If you set it explicitly, keep it within the configured answer model's
   * output cap (Anthropic ≥ 64000; some OpenAI/Google models are lower). The
   * Anthropic answer model runs adaptive thinking, which shares this budget, so a
   * small value can starve the answer. */
  max_tokens: z.number().int().min(64).max(64000).optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const AnswerResponse = z.object({
  /** The grounded natural-language answer */
  answer: z.string(),
  /** Memory ids the answer is grounded in (validated subset of retrieved) */
  based_on: z.array(z.string()),
  /** The memories retrieved as grounding context (provenance) */
  memories: z.array(ScoredMemory),
  /** The model spec actually used, e.g. "anthropic:claude-opus-4-8" */
  model: z.string(),
  /** Token usage for the answer generation call */
  usage: z.object({
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
  }),
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;

// ─── Correction ─────────────────────────────────────────────

export const CorrectionAction = z.enum(['suppress', 'expire', 'delete', 'pin', 'update']);
export type CorrectionAction = z.infer<typeof CorrectionAction>;

export const CorrectionRequest = z
  .object({
    /** ID of the memory to correct */
    memory_id: z.string().min(1),
    /** The correction action to apply */
    action: CorrectionAction,
    /** Scoping context — required to verify ownership */
    scope: Scope,
    /** Reason for the correction (optional, used in audit log) */
    reason: z.string().optional(),
    /** Updated content (required for 'update' action) */
    updated_content: z.string().optional(),
  })
  .refine(
    (data) => data.action !== 'update' || (data.updated_content && data.updated_content.length > 0),
    { message: "updated_content is required for 'update' action", path: ['updated_content'] },
  );
export type CorrectionRequest = z.infer<typeof CorrectionRequest>;

export const CorrectionResponse = z.object({
  /** The correction action applied */
  action: CorrectionAction,
  /** The original memory ID */
  memory_id: z.string(),
  /** New memory ID (for 'update' action, where a new memory replaces the old one) */
  new_memory_id: z.string().nullable(),
  /** Success message */
  message: z.string(),
});
export type CorrectionResponse = z.infer<typeof CorrectionResponse>;

// ─── Health ──────────────────────────────────────────────────

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  service: z.string(),
  timestamp: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'error'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
