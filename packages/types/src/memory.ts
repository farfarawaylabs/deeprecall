import { z } from 'zod';
import { MemoryType, MemoryStatus, SourceType, SourceChannel } from './enums';

/** Full memory record as stored in D1. */
export const Memory = z.object({
  id: z.string(),
  content: z.string(),
  episode: z.string().nullable(),
  type: MemoryType,
  status: MemoryStatus,

  // Scoping (product_id is implicit — each product has its own DB)
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  session_id: z.string().nullable(),

  // Provenance
  source_actor: z.string(),
  source_type: SourceType,
  source_channel: SourceChannel.nullable(),
  confidence: z.number().min(0).max(1),

  // Document reference
  document_id: z.string().nullable(),

  // Lifecycle
  validity_start: z.string().nullable(),
  validity_end: z.string().nullable(),
  observed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  superseded_by: z.string().nullable(),

  // Tags (JSON array)
  tags: z.array(z.string()).nullable(),

  // Relationships (V2 graph support)
  subject: z.string().nullable(),
  predicate: z.string().nullable(),
  object: z.string().nullable(),
});
export type Memory = z.infer<typeof Memory>;

/** Output of LLM extraction, input to policy check and reconciliation. */
export const MemoryCandidate = z.object({
  content: z.string().describe('The core fact, episode, or foresight text'),
  episode: z.string().nullable().describe('Narrative summary of the episode context'),
  type: MemoryType,
  source_actor: z.string().describe('Who said or inferred this'),
  source_type: SourceType,
  confidence: z.number().min(0).max(1).describe('How confident the extraction is'),
  validity_start: z.string().nullable().describe('ISO timestamp for when this becomes valid'),
  validity_end: z
    .string()
    .nullable()
    .describe('ISO timestamp for when this expires (foresight items)'),
  tags: z.array(z.string()).describe('Categorization tags'),
  subject: z.string().nullable().describe('Entity subject (for graph)'),
  predicate: z.string().nullable().describe('Relationship predicate'),
  object: z.string().nullable().describe('Entity object (for graph)'),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;
