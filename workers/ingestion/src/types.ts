import type { IngestionRequest, MemoryCandidate, SceneType } from '@deeprecall/types';

/**
 * Payload passed to the ingestion workflow.
 * product_id is top-level (sourced from API key, not request body).
 */
export interface IngestionPayload extends IngestionRequest {
  product_id: string;
  trace_id: string;
}

/** Output of Step 1: Parse & Classify. */
export interface ParseResult {
  content: string;
  product_id: string;
  scope: IngestionPayload['scope'];
  source_channel: IngestionPayload['source_channel'];
  scene_type: SceneType;
  extraction_template: string | null;
  /** When the content originally occurred (from the ingest request), if known. */
  occurred_at: string | null;
  trace_id: string;
}

/** A candidate with its embedding attached (output of Step 3). */
export interface EmbeddedCandidate {
  candidate: MemoryCandidate;
  embedding: number[];
}

/** Output of Step 4: Policy Check — engine verdicts split into approved candidates and rejections with reasons. */
export interface PolicyResult {
  approved: EmbeddedCandidate[];
  rejected: Array<{ candidate: MemoryCandidate; reason: string }>;
}

/** Output of Step 5: Reconcile. */
export interface ReconcileDecision {
  action: 'add' | 'supersede' | 'merge' | 'skip';
  candidate: EmbeddedCandidate;
  existing_memory_id?: string;
  /** Combined content when action is merge. */
  merged_content?: string;
  /** LLM-provided reason for the decision. */
  reason?: string;
}

/** A candidate that was dropped before persistence, with why. */
export interface IngestionRejection {
  /** Step that dropped the candidate: "policy" or "reconcile". */
  step: 'policy' | 'reconcile';
  /** First 120 chars of the candidate content for operator visibility. */
  content_preview: string;
  /** Human-readable reason (policy rule message or reconcile SKIP reason). */
  reason: string;
}

/** Final output of the workflow. */
export interface IngestionResult {
  memory_ids: string[];
  candidates_extracted: number;
  candidates_approved: number;
  candidates_persisted: number;
  /** Candidates rejected by policy or skipped by reconcile. Empty on clean runs. */
  rejections: IngestionRejection[];
}
