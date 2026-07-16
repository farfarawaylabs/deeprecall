import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory, MemoryCandidate } from '@deeprecall/types';
import type { EmbeddedCandidate, ReconcileDecision } from '../../src/types';
import { persist } from '../../src/steps/persist';

function makeEmbeddedCandidate(overrides: Partial<MemoryCandidate> = {}): EmbeddedCandidate {
  return {
    candidate: {
      content: 'User likes Python',
      episode: null,
      type: 'fact',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 0.9,
      validity_start: null,
      validity_end: null,
      tags: ['preference'],
      subject: 'user',
      predicate: 'likes',
      object: 'Python',
      ...overrides,
    },
    embedding: [0.1, 0.2, 0.3],
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'old-mem-1',
    content: 'User likes JavaScript',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'chat',
    confidence: 0.8,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: '2025-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    superseded_by: null,
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

function makeMockData() {
  return {
    memoryCreate: vi.fn((_, input) => Promise.resolve({ ...makeMemory(), ...input })),
    memoryGetById: vi
      .fn()
      .mockImplementation(async (_productId: string, id: string) =>
        id === 'old-mem-1' ? makeMemory() : null,
      ),
    memoryUpdateStatus: vi.fn().mockResolvedValue(undefined),
    vectorUpsertMany: vi.fn().mockResolvedValue(undefined),
    vectorDeleteMany: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
    generateEmbeddings: vi.fn().mockResolvedValue([[0.7, 0.8, 0.9]]),
  };
}

const scope = { user_id: 'user-1' };
const productId = 'default';

describe('persist', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    data = makeMockData();
  });

  it('returns empty array for skip decisions', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'skip',
        candidate: makeEmbeddedCandidate(),
        reason: 'Duplicate',
      },
    ];

    const ids = await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    expect(ids).toEqual([]);
    expect(data.memoryCreate).not.toHaveBeenCalled();
  });

  it('creates memory, upserts vector, and logs audit for ADD', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate(),
        reason: 'New memory',
      },
    ];

    const ids = await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    expect(ids).toHaveLength(1);
    expect(data.memoryCreate).toHaveBeenCalledOnce();
    expect(data.vectorUpsertMany).toHaveBeenCalledOnce();
    expect(data.vectorUpsertMany.mock.calls[0][1]).toHaveLength(1);
    expect(data.auditLog).toHaveBeenCalledOnce();

    // Verify audit action
    const auditCall = data.auditLog.mock.calls[0];
    expect(auditCall[1]).toBe('created');
    expect(auditCall[6]).toBe('ingestion_pipeline');
  });

  it('handles SUPERSEDE: creates new, marks old, deletes old vector', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'supersede',
        candidate: makeEmbeddedCandidate(),
        existing_memory_id: 'old-mem-1',
        reason: 'Updated preference',
      },
    ];

    const ids = await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    expect(ids).toHaveLength(1);
    // Creates new memory first (FK constraint)
    expect(data.memoryCreate).toHaveBeenCalledOnce();
    // Marks old as superseded with reference to new
    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      productId,
      'old-mem-1',
      'superseded',
      ids[0],
    );
    // Deletes old vector
    expect(data.vectorDeleteMany).toHaveBeenCalledWith(productId, ['old-mem-1']);
    // Upserts new vector
    expect(data.vectorUpsertMany).toHaveBeenCalledOnce();
    // Two audit logs: supersede old + create new
    expect(data.auditLog).toHaveBeenCalledTimes(2);
    expect(data.auditLog.mock.calls[0][1]).toBe('superseded');
    expect(data.auditLog.mock.calls[1][1]).toBe('created');
  });

  it('handles MERGE: re-embeds merged content, uses max confidence', async () => {
    data.memoryGetById.mockImplementation(async (_p: string, id: string) =>
      id === 'old-mem-1' ? makeMemory({ confidence: 0.85 }) : null,
    );

    const decisions: ReconcileDecision[] = [
      {
        action: 'merge',
        candidate: makeEmbeddedCandidate({ confidence: 0.7 }),
        existing_memory_id: 'old-mem-1',
        merged_content: 'User likes Python and JavaScript',
        reason: 'Complementary info',
      },
    ];

    const ids = await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    expect(ids).toHaveLength(1);
    // Re-embeds the merged content
    expect(data.generateEmbeddings).toHaveBeenCalledWith(['User likes Python and JavaScript']);
    // Creates memory with merged content
    const createCall = data.memoryCreate.mock.calls[0][1];
    expect(createCall.content).toBe('User likes Python and JavaScript');
    // Confidence is max of candidate (0.7) and old (0.85)
    expect(createCall.confidence).toBe(0.85);
    // Two audit logs: merge old + create new
    expect(data.auditLog).toHaveBeenCalledTimes(2);
    expect(data.auditLog.mock.calls[0][1]).toBe('merged');
  });

  it('preserves document_id when provided', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate(),
        reason: 'From document',
      },
    ];

    await persist(decisions, scope, 'document', data, productId, 'wf-test-1', 'doc-123');

    const createCall = data.memoryCreate.mock.calls[0][1];
    expect(createCall.document_id).toBe('doc-123');
    expect(createCall.source_channel).toBe('document');
  });

  it('processes multiple decisions', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate({ content: 'Fact A' }),
        reason: 'New',
      },
      {
        action: 'skip',
        candidate: makeEmbeddedCandidate({ content: 'Duplicate' }),
        reason: 'Skip',
      },
      {
        action: 'add',
        candidate: makeEmbeddedCandidate({ content: 'Fact B' }),
        reason: 'New',
      },
    ];

    const ids = await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    // Only 2 ADD decisions produce IDs (skip is ignored)
    expect(ids).toHaveLength(2);
    expect(data.memoryCreate).toHaveBeenCalledTimes(2);
    // Vector writes are flushed as ONE batched call, not one per memory
    // (per-vector calls rate-limited Vectorize during bulk imports).
    expect(data.vectorUpsertMany).toHaveBeenCalledOnce();
    expect(data.vectorUpsertMany.mock.calls[0][1]).toHaveLength(2);
    expect(data.vectorDeleteMany).not.toHaveBeenCalled();
  });

  it('agent-only scope: omits user_id from Vectorize metadata (never writes null)', async () => {
    const agentScope = { agent_id: 'agent-only-1' };
    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate(),
        reason: 'Agent knowledge',
      },
    ];

    await persist(decisions, agentScope, 'chat', data, productId, 'wf-test-1');

    const upsertCall = data.vectorUpsertMany.mock.calls[0];
    // Args: (productId, items[]) — one pending upsert for the single ADD
    const metadata = upsertCall[1][0].metadata as Record<string, unknown>;
    expect(metadata.agent_id).toBe('agent-only-1');
    expect('user_id' in metadata).toBe(false);

    // And D1 create gets explicit nulls for missing scope keys.
    const createInput = data.memoryCreate.mock.calls[0][1];
    expect(createInput.user_id).toBeNull();
    expect(createInput.agent_id).toBe('agent-only-1');
  });

  it('uses candidate embedding when no merged_content', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'merge',
        candidate: makeEmbeddedCandidate(),
        existing_memory_id: 'old-mem-1',
        // No merged_content — use candidate's content and embedding
        reason: 'Merge',
      },
    ];

    await persist(decisions, scope, 'chat', data, productId, 'wf-test-1');

    // Should NOT re-embed since no merged_content
    expect(data.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('produces the same ids on retry and does not re-create memories', async () => {
    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate(),
        reason: 'New fact',
      },
    ];

    const first = await persist(decisions, scope, 'chat', data, productId, 'wf-retry-1');
    expect(data.memoryCreate).toHaveBeenCalledTimes(1);
    const createdId = first[0];

    // Simulate the step retrying: the memory now exists under its
    // deterministic id. Same instanceId must yield the same id and skip
    // creation + created-audit.
    data.memoryGetById.mockImplementation(async (_p: string, id: string) =>
      id === createdId ? makeMemory({ id: createdId }) : null,
    );
    const second = await persist(decisions, scope, 'chat', data, productId, 'wf-retry-1');

    expect(second).toEqual(first);
    expect(data.memoryCreate).toHaveBeenCalledTimes(1);
  });

  it('different workflow instances produce different ids', async () => {
    const decisions: ReconcileDecision[] = [
      { action: 'add', candidate: makeEmbeddedCandidate(), reason: 'New' },
    ];
    const a = await persist(decisions, scope, 'chat', data, productId, 'wf-A');
    const b = await persist(decisions, scope, 'chat', data, productId, 'wf-B');
    expect(a[0]).not.toEqual(b[0]);
  });
});
