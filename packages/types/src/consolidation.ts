import { z } from 'zod';
import { Scope } from './scope';

// ─── Consolidation Message Types ────────────────────────────

export const ConsolidationMessageType = z.enum([
  'ingestion_complete',
  'profile_rebuild',
  'expiry_sweep',
  'confidence_decay',
  'conflict_resolution',
]);
export type ConsolidationMessageType = z.infer<typeof ConsolidationMessageType>;

export const ConsolidationMessage = z.object({
  type: ConsolidationMessageType,
  product_id: z.string().min(1),
  scope: Scope,
  memory_ids: z.array(z.string()).optional(),
  triggered_by: z.string().optional(),
  created_at: z.string(),
});
export type ConsolidationMessage = z.infer<typeof ConsolidationMessage>;

// ─── Dead Letter ────────────────────────────────────────────

export const DeadLetter = z.object({
  id: z.string(),
  queue_name: z.string(),
  payload: z.string(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  first_failed_at: z.string(),
  last_failed_at: z.string(),
});
export type DeadLetter = z.infer<typeof DeadLetter>;
