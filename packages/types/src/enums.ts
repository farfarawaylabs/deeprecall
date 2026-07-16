import { z } from 'zod';

export const MemoryType = z.enum(['fact', 'episode', 'foresight', 'profile']);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemoryStatus = z.enum(['active', 'superseded', 'expired', 'archived', 'suppressed']);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const SourceType = z.enum([
  'user_stated',
  'agent_inferred',
  'system_imported',
  'document_extracted',
  'api_ingested',
]);
export type SourceType = z.infer<typeof SourceType>;

export const SourceChannel = z.enum(['chat', 'document', 'api', 'research', 'manual']);
export type SourceChannel = z.infer<typeof SourceChannel>;

export const SceneType = z.enum([
  'one_on_one_chat',
  'group_chat',
  'document',
  'system_event',
  'api_direct',
]);
export type SceneType = z.infer<typeof SceneType>;

/**
 * Closed set of file formats the ingestion pipeline can actually extract
 * text from. Derived server-side from MIME type + filename at upload time —
 * not accepted from the client. `document_type` (a free-form string on the
 * document row) is the *classification* tag; `file_type` is the *format*.
 */
export const FileType = z.enum(['pdf', 'markdown', 'text', 'json']);
export type FileType = z.infer<typeof FileType>;

export const AuditAction = z.enum([
  'created',
  'superseded',
  'merged',
  'expired',
  'suppressed',
  'deleted',
  'confidence_updated',
  'corrected',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditTrigger = z.enum([
  'ingestion_pipeline',
  'consolidation',
  'user_correction',
  'expiry_sweep',
]);
export type AuditTrigger = z.infer<typeof AuditTrigger>;
