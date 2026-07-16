import { env, createExecutionContext } from 'cloudflare:test';
import type { MemoryCreateInput, DocumentCreateInput, DeadLetterEntry } from '@deeprecall/db';
import { DataService } from '../src/index';

/**
 * Construct a DataService directly (not over RPC) so tests can inject stub
 * bindings for resources miniflare cannot simulate locally (Vectorize, AI).
 */
export function makeService(overrides: Record<string, unknown> = {}): DataService {
  type DataEnv = ConstructorParameters<typeof DataService>[1];
  return new DataService(createExecutionContext(), { ...env, ...overrides } as DataEnv);
}

export function makeMemoryInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'User likes TypeScript',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'chat',
    confidence: 0.9,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: new Date().toISOString(),
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

export function makeDocumentInput(
  overrides: Partial<DocumentCreateInput> = {},
): DocumentCreateInput {
  const id = crypto.randomUUID();
  return {
    id,
    r2_key: `default/documents/${id}`,
    filename: 'notes.md',
    mime_type: 'text/markdown',
    size_bytes: 42,
    file_type: 'markdown',
    document_type: null,
    description: null,
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    metadata: null,
    ...overrides,
  };
}

export function makeDeadLetter(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    queue_name: 'ingestion-queue',
    payload: JSON.stringify({ hello: 'world' }),
    error: 'boom',
    attempts: 3,
    first_failed_at: now,
    last_failed_at: now,
    ...overrides,
  };
}
