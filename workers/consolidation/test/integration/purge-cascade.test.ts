/**
 * Purge cascade over REAL local D1.
 *
 * The mock-based suite in test/jobs/purge.test.ts pins dispatch and call
 * shapes; this suite pins that the REAL purge job code, running against the
 * real repositories, deletes exactly the targeted scope: memories, their
 * audit rows, their FTS index entries — and nothing belonging to any other
 * scope. Vectorize has no miniflare simulator, so the vector arm is a
 * vi.fn stub whose exact id set is asserted.
 */
import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
// Applies migrations and registers the per-test table wipe (see file header).
import '../apply-migrations';
import type { PurgeMessage } from '@deeprecall/types';
import type { MemoryCreateInput, DocumentCreateInput } from '@deeprecall/db';
import { DataService } from '@deeprecall/worker-data';
import { runPurge } from '../../src/jobs/purge';

const PRODUCT_ID = 'default';

type DataEnv = ConstructorParameters<typeof DataService>[1];

function makeHarness() {
  // Direct construction (not RPC) with only the real D1 binding. The purge
  // job's vector arm is stubbed at the same RPC method boundary it uses in
  // production; all D1 methods run the real repositories.
  const service = new DataService(createExecutionContext(), {
    DB_default: env.DB_default,
  } as DataEnv);

  const vectorDeleteMany = vi.fn().mockResolvedValue(undefined);

  const data = {
    memoryListIdsByScopeStrict: service.memoryListIdsByScopeStrict.bind(service),
    memoryDeleteByScope: service.memoryDeleteByScope.bind(service),
    auditDeleteByMemoryIds: service.auditDeleteByMemoryIds.bind(service),
    vectorDeleteMany,
  } as unknown as Service<DataService>;

  return { service, data, vectorDeleteMany };
}

function makeMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function makeMemoryInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'placeholder',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: null,
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

function makeDocumentInput(overrides: Partial<DocumentCreateInput> = {}): DocumentCreateInput {
  const id = crypto.randomUUID();
  return {
    id,
    r2_key: `${PRODUCT_ID}/documents/${id}`,
    filename: 'notes.md',
    mime_type: 'text/markdown',
    size_bytes: 42,
    file_type: 'markdown',
    document_type: null,
    description: null,
    user_id: null,
    agent_id: null,
    session_id: null,
    metadata: null,
    ...overrides,
  };
}

function makePurgeMessage(jobId: string): PurgeMessage {
  return {
    kind: 'purge',
    type: 'purge_scoped',
    job_id: jobId,
    product_id: PRODUCT_ID,
    scope: { user_id: 'user-a' },
    created_at: new Date().toISOString(),
  };
}

function makeInitialJobStatus(jobId: string): string {
  return JSON.stringify({
    job_id: jobId,
    product_id: PRODUCT_ID,
    type: 'purge_scoped',
    status: 'pending',
    scope: { user_id: 'user-a' },
    memories_deleted: 0,
    vectors_deleted: 0,
    audits_deleted: 0,
    documents_deleted: 0,
    r2_blobs_deleted: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
  });
}

/** Seed two user scopes plus a standalone agent scope, each with audits + docs. */
async function seed(service: DataService) {
  const userA1 = await service.memoryCreate(
    PRODUCT_ID,
    makeMemoryInput({ user_id: 'user-a', content: 'User A plays saxophone weekly' }),
  );
  const userA2 = await service.memoryCreate(
    PRODUCT_ID,
    makeMemoryInput({ user_id: 'user-a', content: 'User A lives in Lisbon' }),
  );
  const userB = await service.memoryCreate(
    PRODUCT_ID,
    makeMemoryInput({ user_id: 'user-b', content: 'User B collects vintage typewriters' }),
  );
  // Standalone agent-scoped memory: user_id NULL. A strict user_id purge
  // must NOT sweep this up (null does not match strict scope).
  const agent = await service.memoryCreate(
    PRODUCT_ID,
    makeMemoryInput({ agent_id: 'agent-x', content: 'Agent workflow prefers batch processing' }),
  );

  for (const m of [userA1, userA2, userB, agent]) {
    await service.auditLog(PRODUCT_ID, 'created', m.id, 'seed', null, m, 'ingestion_pipeline');
  }

  const docA = await service.documentRecordCreate(
    PRODUCT_ID,
    makeDocumentInput({ user_id: 'user-a', filename: 'a-notes.md' }),
  );
  const docB = await service.documentRecordCreate(
    PRODUCT_ID,
    makeDocumentInput({ user_id: 'user-b', filename: 'b-notes.md' }),
  );

  return { userA1, userA2, userB, agent, docA, docB };
}

describe('purge_scoped cascade over real D1', () => {
  it('deletes exactly the target scope: memories, audits, FTS entries, vectors', async () => {
    const { service, data, vectorDeleteMany } = makeHarness();
    const seeded = await seed(service);
    const jobId = 'job-int-1';
    const kv = makeMockKv({ [`purge_job:${PRODUCT_ID}:${jobId}`]: makeInitialJobStatus(jobId) });

    const result = await runPurge(makePurgeMessage(jobId), data, kv);

    // D1 meta.changes on the memories DELETE includes FTS trigger writes,
    // so the count is a lower bound; the survivor set below is exact.
    expect(result.memories_deleted).toBeGreaterThanOrEqual(2);
    expect(result.audits_deleted).toBe(2);
    expect(result.vectors_deleted).toBe(2);
    expect(result.documents_deleted).toBe(0);

    // Vector cleanup targeted exactly the user-a memory ids.
    expect(vectorDeleteMany).toHaveBeenCalledOnce();
    const [vecProduct, vecIds] = vectorDeleteMany.mock.calls[0];
    expect(vecProduct).toBe(PRODUCT_ID);
    expect([...vecIds].sort()).toEqual([seeded.userA1.id, seeded.userA2.id].sort());

    // Every user-a memory row is gone; user-b and the agent-scoped row survive.
    const userAIds = [seeded.userA1.id, seeded.userA2.id];
    expect(await service.memoryGetByIds(PRODUCT_ID, userAIds)).toEqual([]);
    const survivors = await service.memoryGetByIds(PRODUCT_ID, [seeded.userB.id, seeded.agent.id]);
    expect(survivors.map((m) => m.id).sort()).toEqual([seeded.userB.id, seeded.agent.id].sort());
    expect(survivors.every((m) => m.status === 'active')).toBe(true);

    // Audit rows: user-a's wiped, everyone else's intact.
    for (const id of userAIds) {
      expect(await service.auditGetByMemoryId(PRODUCT_ID, id)).toEqual([]);
    }
    expect(await service.auditGetByMemoryId(PRODUCT_ID, seeded.userB.id)).toHaveLength(1);
    expect(await service.auditGetByMemoryId(PRODUCT_ID, seeded.agent.id)).toHaveLength(1);

    // FTS no longer returns user-a content (the AFTER DELETE trigger fired),
    // while other scopes' content remains searchable.
    const goneHits = await service.memorySearch(PRODUCT_ID, 'saxophone', { user_id: 'user-a' }, 10);
    expect(goneHits).toEqual([]);
    const bHits = await service.memorySearch(PRODUCT_ID, 'typewriters', { user_id: 'user-b' }, 10);
    expect(bHits.map((m) => m.id)).toContain(seeded.userB.id);
    const agentHits = await service.memorySearch(PRODUCT_ID, 'batch', { agent_id: 'agent-x' }, 10);
    expect(agentHits.map((m) => m.id)).toContain(seeded.agent.id);

    // purge_scoped is memory-only: documents in BOTH scopes are untouched.
    expect(await service.documentRecordGetById(PRODUCT_ID, seeded.docA.id)).not.toBeNull();
    expect(await service.documentRecordGetById(PRODUCT_ID, seeded.docB.id)).not.toBeNull();

    // Job status in KV reached the terminal state with the real counts.
    const stored = JSON.parse(kv.store.get(`purge_job:${PRODUCT_ID}:${jobId}`)!);
    expect(stored.status).toBe('completed');
    expect(stored.audits_deleted).toBe(2);
    expect(stored.vectors_deleted).toBe(2);
    expect(stored.started_at).not.toBeNull();
    expect(stored.completed_at).not.toBeNull();
  });

  it('is idempotent under queue retry: a second run deletes nothing more', async () => {
    const { service, data, vectorDeleteMany } = makeHarness();
    const seeded = await seed(service);
    const jobId = 'job-int-2';
    const kv = makeMockKv({ [`purge_job:${PRODUCT_ID}:${jobId}`]: makeInitialJobStatus(jobId) });

    await runPurge(makePurgeMessage(jobId), data, kv);
    vectorDeleteMany.mockClear();

    // Queue retry redelivers the same message after the first run completed.
    const second = await runPurge(makePurgeMessage(jobId), data, kv);

    expect(second.memories_deleted).toBe(0);
    expect(second.audits_deleted).toBe(0);
    expect(second.vectors_deleted).toBe(0);
    // No ids left to target — the vector arm is not called with stale ids.
    expect(vectorDeleteMany).not.toHaveBeenCalled();

    // Survivors are still fully intact after the retry.
    const survivors = await service.memoryGetByIds(PRODUCT_ID, [seeded.userB.id, seeded.agent.id]);
    expect(survivors).toHaveLength(2);
    expect(await service.auditGetByMemoryId(PRODUCT_ID, seeded.userB.id)).toHaveLength(1);
  });
});
