import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory, MemoryCandidate } from '@deeprecall/types';
import type { EmbeddedCandidate } from '../../src/types';
import type { ReconcileEnv } from '../../src/steps/reconcile';

// Mock @deeprecall/ai before importing reconcile
vi.mock('@deeprecall/ai', () => ({
  reconcileCandidate: vi.fn(),
}));

import { reconcile } from '../../src/steps/reconcile';
import { reconcileCandidate } from '@deeprecall/ai';

const mockReconcileCandidate = vi.mocked(reconcileCandidate);

function makeEmbeddedCandidate(overrides: Partial<MemoryCandidate> = {}): EmbeddedCandidate {
  return {
    candidate: {
      content: 'User prefers TypeScript',
      episode: null,
      type: 'fact',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 0.9,
      validity_start: null,
      validity_end: null,
      tags: [],
      subject: null,
      predicate: null,
      object: null,
      ...overrides,
    },
    embedding: [0.1, 0.2, 0.3],
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'existing-1',
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

function makeEnv(overrides: Partial<ReconcileEnv['data']> = {}): ReconcileEnv {
  return {
    data: {
      vectorSearch: vi.fn().mockResolvedValue([]),
      memoryGetByIds: vi.fn().mockResolvedValue([]),
      memoryListByScope: vi.fn().mockResolvedValue({ items: [] }),
      generateEmbeddings: vi.fn().mockResolvedValue([]),
      ...overrides,
    },
    productId: 'default',
    claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
    scope: { user_id: 'user-1' },
  };
}

describe('reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ADD when no similar memories exist', async () => {
    const env = makeEnv();
    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('add');
    expect(decisions[0].reason).toContain('No similar existing memories');
    expect(mockReconcileCandidate).not.toHaveBeenCalled();
  });

  it('returns ADD when similar vectors below threshold (0.6)', async () => {
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.5 }]),
    });

    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(decisions[0].action).toBe('add');
  });

  it('auto-SKIPs only near-verbatim matches (above 0.95)', async () => {
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.97 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([makeMemory()]),
    });

    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(decisions[0].action).toBe('skip');
    expect(decisions[0].existing_memory_id).toBe('existing-1');
    expect(decisions[0].reason).toContain('Auto-skipped');
    expect(mockReconcileCandidate).not.toHaveBeenCalled();
  });

  it('routes 0.85-0.95 matches to the LLM (contradicting updates score here)', async () => {
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.92 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([makeMemory()]),
    });

    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'supersede',
      reason: 'Updated fact',
      existing_memory_id: 'existing-1',
      merged_content: null,
    });

    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(mockReconcileCandidate).toHaveBeenCalledOnce();
    expect(decisions[0].action).toBe('supersede');
  });

  it("finds recent same-scope memories via D1 when Vectorize hasn't indexed them", async () => {
    const recentMemory = makeMemory({ id: 'recent-1' });
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([]), // index lag: nothing found
      memoryListByScope: vi.fn().mockResolvedValue({ items: [recentMemory] }),
      // Recent memory embeds to a vector with cosine ≈ 0.8 vs the candidate
      generateEmbeddings: vi.fn().mockResolvedValue([[0.8, 0.6, 0]]),
      memoryGetByIds: vi.fn().mockResolvedValue([recentMemory]),
    });

    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'skip',
      reason: 'Duplicate of recent memory',
      existing_memory_id: 'recent-1',
      merged_content: null,
    });

    const candidate = makeEmbeddedCandidate();
    candidate.embedding = [1, 0, 0];
    const decisions = await reconcile([candidate], env);

    expect(env.data.memoryListByScope).toHaveBeenCalledWith(
      'default',
      { user_id: 'user-1', agent_id: undefined, status: 'active' },
      { limit: 30 },
    );
    expect(mockReconcileCandidate).toHaveBeenCalledOnce();
    expect(decisions[0].action).toBe('skip');
    expect(decisions[0].existing_memory_id).toBe('recent-1');
  });

  it('handles ghost vectors (vector exists but no D1 record)', async () => {
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'ghost-1', score: 0.9 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([]), // No D1 records
    });

    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(decisions[0].action).toBe('add');
    expect(decisions[0].reason).toContain('ghost vectors');
  });

  it('skips agent-inferred candidate conflicting with pinned memory', async () => {
    const pinnedMemory = makeMemory({
      source_type: 'user_stated',
      confidence: 1.0,
    });
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.75 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([pinnedMemory]),
    });

    const candidate = makeEmbeddedCandidate({ source_type: 'agent_inferred' });
    const decisions = await reconcile([candidate], env);

    expect(decisions[0].action).toBe('skip');
    expect(decisions[0].reason).toContain('pinned memory');
  });

  it('calls LLM for moderate similarity (0.6-0.85)', async () => {
    const existingMemory = makeMemory();
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.72 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([existingMemory]),
    });

    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'supersede',
      reason: 'Updated preference',
      existing_memory_id: 'existing-1',
      merged_content: null,
    });

    const decisions = await reconcile([makeEmbeddedCandidate()], env);

    expect(mockReconcileCandidate).toHaveBeenCalledOnce();
    expect(decisions[0].action).toBe('supersede');
    expect(decisions[0].existing_memory_id).toBe('existing-1');
  });

  it('processes multiple candidates independently', async () => {
    const env = makeEnv();
    const candidates = [
      makeEmbeddedCandidate({ content: 'Fact A' }),
      makeEmbeddedCandidate({ content: 'Fact B' }),
    ];

    const decisions = await reconcile(candidates, env);

    expect(decisions).toHaveLength(2);
    expect(decisions[0].action).toBe('add');
    expect(decisions[1].action).toBe('add');
  });

  it('agent-only scope: searches Vectorize using agent_id filter', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([]);
    const env: ReconcileEnv = {
      data: {
        vectorSearch,
        memoryGetByIds: vi.fn().mockResolvedValue([]),
        memoryListByScope: vi.fn().mockResolvedValue({ items: [] }),
        generateEmbeddings: vi.fn().mockResolvedValue([]),
      },
      productId: 'default',
      claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
      scope: { agent_id: 'agent-r-1' },
    };

    await reconcile([makeEmbeddedCandidate()], env);

    // Single filter variant (agent_id only), no user_id filter call.
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    const filterArg = vectorSearch.mock.calls[0][2] as {
      user_id?: string;
      agent_id?: string;
      status?: string;
    };
    expect(filterArg.agent_id).toBe('agent-r-1');
    expect(filterArg.user_id).toBeUndefined();
    expect(filterArg.status).toBe('active');
  });

  it('both user+agent scope: fans out two Vectorize queries and unions results', async () => {
    const vectorSearch = vi
      .fn()
      .mockResolvedValueOnce([{ memory_id: 'mem-user', score: 0.75 }])
      .mockResolvedValueOnce([{ memory_id: 'mem-agent', score: 0.8 }]);
    const env: ReconcileEnv = {
      data: {
        vectorSearch,
        memoryGetByIds: vi
          .fn()
          .mockResolvedValue([makeMemory({ id: 'mem-user' }), makeMemory({ id: 'mem-agent' })]),
        memoryListByScope: vi.fn().mockResolvedValue({ items: [] }),
        generateEmbeddings: vi.fn().mockResolvedValue([]),
      },
      productId: 'default',
      claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
      scope: { user_id: 'user-B', agent_id: 'agent-B' },
    };

    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'skip',
      reason: 'both',
      existing_memory_id: 'mem-agent',
      merged_content: null,
    });

    await reconcile([makeEmbeddedCandidate()], env);

    // Two filter variants (user_id-only + agent_id-only), unioned upstream.
    expect(vectorSearch).toHaveBeenCalledTimes(2);
    const filters = vectorSearch.mock.calls.map((c) => c[2]);
    expect(filters).toContainEqual({ user_id: 'user-B', status: 'active' });
    expect(filters).toContainEqual({ agent_id: 'agent-B', status: 'active' });
  });

  it('does not skip pinned conflict for user_stated candidates', async () => {
    const pinnedMemory = makeMemory({
      source_type: 'user_stated',
      confidence: 1.0,
    });
    const env = makeEnv({
      vectorSearch: vi.fn().mockResolvedValue([{ memory_id: 'existing-1', score: 0.75 }]),
      memoryGetByIds: vi.fn().mockResolvedValue([pinnedMemory]),
    });

    // The candidate is also user_stated, so pinned check should not trigger
    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'supersede',
      reason: 'User corrected',
      existing_memory_id: 'existing-1',
      merged_content: null,
    });

    const candidate = makeEmbeddedCandidate({ source_type: 'user_stated' });
    const decisions = await reconcile([candidate], env);

    // Should NOT skip — pinned check only applies to agent_inferred candidates
    expect(decisions[0].action).toBe('supersede');
    expect(mockReconcileCandidate).toHaveBeenCalledOnce();
  });
});
