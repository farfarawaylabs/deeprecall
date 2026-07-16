import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';
import type { RetrievalRequest } from '../../src/search/types';
import { hybridSearch } from '../../src/search/hybrid-search';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'Test memory',
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

function makeRequest(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    query: 'What does the user like?',
    scope: { user_id: 'user-1' },
    mode: 'recall',
    top_k: 5,
    ...overrides,
  };
}

function makeMockData() {
  return {
    generateEmbeddings: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    vectorSearch: vi.fn().mockResolvedValue([]),
    memorySearch: vi.fn().mockResolvedValue([]),
    memoryGetByIds: vi.fn().mockResolvedValue([]),
    memoryListByScope: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    // Default: preserve incoming order with descending scores, so tests
    // that assert on fusion order still hold under the rerank step.
    rerank: vi
      .fn()
      .mockImplementation(async (_query: string, texts: string[]) =>
        texts.map((_, i) => 1 - i * 0.01),
      ),
  };
}

describe('hybridSearch', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    data = makeMockData();
  });

  // ── profile mode ──────────────────────────────────────────

  describe('profile mode', () => {
    it('returns profile memories without embedding query', async () => {
      const profile = makeMemory({ type: 'profile', content: 'User profile' });
      data.memoryListByScope.mockResolvedValue({ items: [profile], cursor: null });

      const results = await hybridSearch(makeRequest({ mode: 'profile' }), data, 'default');

      expect(results).toHaveLength(1);
      expect(results[0].memory.type).toBe('profile');
      expect(results[0].score).toBe(1.0);
      expect(data.generateEmbeddings).not.toHaveBeenCalled();
    });
  });

  // ── hybrid mode ───────────────────────────────────────────

  describe('hybrid mode', () => {
    it('fans out vectorize and FTS5 searches in parallel', async () => {
      await hybridSearch(makeRequest(), data, 'default');

      expect(data.generateEmbeddings).toHaveBeenCalledWith(['What does the user like?']);
      expect(data.vectorSearch).toHaveBeenCalledOnce();
      expect(data.memorySearch).toHaveBeenCalledOnce();
    });

    it('returns empty results when no matches', async () => {
      const results = await hybridSearch(makeRequest(), data, 'default');
      expect(results).toEqual([]);
    });

    it('returns vectorize-only results when FTS5 has no matches', async () => {
      const mem1 = makeMemory({ content: 'TypeScript preference' });
      data.vectorSearch.mockResolvedValue([{ memory_id: mem1.id, score: 0.85 }]);
      data.memoryGetByIds.mockResolvedValue([mem1]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe(mem1.id);
    });

    it('returns FTS5-only results when vectorize has no matches', async () => {
      const mem1 = makeMemory({ content: 'Python knowledge' });
      data.memorySearch.mockResolvedValue([mem1]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe(mem1.id);
    });

    it('boosts memories appearing in both sources via RRF', async () => {
      const sharedMemory = makeMemory({ content: 'Shared result', confidence: 0.8 });
      const vectorOnly = makeMemory({ content: 'Vector only', confidence: 0.8 });

      data.vectorSearch.mockResolvedValue([
        { memory_id: sharedMemory.id, score: 0.9 },
        { memory_id: vectorOnly.id, score: 0.8 },
      ]);
      data.memoryGetByIds.mockResolvedValue([sharedMemory, vectorOnly]);
      data.memorySearch.mockResolvedValue([sharedMemory]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      // Shared memory gets additive RRF score from both sources
      expect(results[0].memory.id).toBe(sharedMemory.id);
    });

    it('respects top_k limit', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => makeMemory({ content: `Memory ${i}` }));
      data.vectorSearch.mockResolvedValue(
        memories.map((m, i) => ({ memory_id: m.id, score: 0.9 - i * 0.05 })),
      );
      data.memoryGetByIds.mockResolvedValue(memories);

      const results = await hybridSearch(makeRequest({ top_k: 3 }), data, 'default');

      expect(results).toHaveLength(3);
    });

    it('filters out superseded memories in post-filter', async () => {
      const active = makeMemory({ status: 'active', content: 'Active' });
      const superseded = makeMemory({ status: 'superseded', content: 'Superseded' });

      data.vectorSearch.mockResolvedValue([
        { memory_id: active.id, score: 0.9 },
        { memory_id: superseded.id, score: 0.85 },
      ]);
      data.memoryGetByIds.mockResolvedValue([active, superseded]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results).toHaveLength(1);
      expect(results[0].memory.status).toBe('active');
    });

    it('keeps foresight past its validity_end retrievable as history', async () => {
      const pastDate = new Date(Date.now() - 86400_000).toISOString();
      const pastPlan = makeMemory({
        type: 'foresight',
        validity_end: pastDate,
        content: 'Art show planned for last September',
      });
      const active = makeMemory({ content: 'Active fact' });

      data.vectorSearch.mockResolvedValue([
        { memory_id: active.id, score: 0.9 },
        { memory_id: pastPlan.id, score: 0.85 },
      ]);
      data.memoryGetByIds.mockResolvedValue([active, pastPlan]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      const ids = results.map((r) => r.memory.id);
      expect(ids).toContain(active.id);
      expect(ids).toContain(pastPlan.id);
    });

    it('handles ghost vectors (vectorize returns IDs not in D1)', async () => {
      const realMemory = makeMemory({ content: 'Real memory' });
      data.vectorSearch.mockResolvedValue([
        { memory_id: 'ghost-id', score: 0.95 },
        { memory_id: realMemory.id, score: 0.85 },
      ]);
      // Only realMemory exists in D1
      data.memoryGetByIds.mockResolvedValue([realMemory]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe(realMemory.id);
    });
  });

  // ── full_briefing mode ────────────────────────────────────

  describe('full_briefing mode', () => {
    it('prepends profile and foresight memories', async () => {
      const fact = makeMemory({ content: 'User fact', type: 'fact' });
      const profile = makeMemory({ content: 'User profile', type: 'profile' });
      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      const foresight = makeMemory({
        content: 'Meeting tomorrow',
        type: 'foresight',
        validity_end: futureDate,
      });

      // Hybrid results
      data.vectorSearch.mockResolvedValue([{ memory_id: fact.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([fact]);

      // Enrichment queries
      data.memoryListByScope
        .mockResolvedValueOnce({ items: [profile], cursor: null }) // profiles
        .mockResolvedValueOnce({ items: [foresight], cursor: null }); // foresight

      const results = await hybridSearch(makeRequest({ mode: 'full_briefing' }), data, 'default');

      expect(results.length).toBeGreaterThanOrEqual(3);
      // Profile and foresight should be prepended
      expect(results[0].memory.type).toBe('profile');
      expect(results[0].score).toBe(1.0);
      expect(results[1].memory.type).toBe('foresight');
      expect(results[1].score).toBe(0.95);
    });

    it('deduplicates enriched results', async () => {
      const memory = makeMemory({ type: 'profile', content: 'Profile' });

      // Appears in both hybrid results and profile enrichment
      data.vectorSearch.mockResolvedValue([{ memory_id: memory.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([memory]);
      data.memoryListByScope
        .mockResolvedValueOnce({ items: [memory], cursor: null })
        .mockResolvedValueOnce({ items: [], cursor: null });

      const results = await hybridSearch(makeRequest({ mode: 'full_briefing' }), data, 'default');

      const ids = results.map((r) => r.memory.id);
      const unique = [...new Set(ids)];
      expect(ids.length).toBe(unique.length);
    });
  });

  // ── recall mode ───────────────────────────────────────────

  describe('recall mode', () => {
    it('does NOT inject foresight - memories earn their place via the funnel', async () => {
      const fact = makeMemory({ content: 'Fact', type: 'fact' });
      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      const foresight = makeMemory({
        content: 'Upcoming meeting',
        type: 'foresight',
        validity_end: futureDate,
      });

      data.vectorSearch.mockResolvedValue([{ memory_id: fact.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([fact]);
      data.memoryListByScope.mockResolvedValue({
        items: [foresight],
        cursor: null,
      });

      const results = await hybridSearch(makeRequest({ mode: 'recall' }), data, 'default');

      // Only the retrieved fact — no unconditional foresight injection
      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe(fact.id);
    });
  });

  describe('cross-encoder rerank', () => {
    it('orders results by reranker score, not fusion rank', async () => {
      const noise = makeMemory({ content: 'Generic noise about painting' });
      const relevant = makeMemory({ content: 'The specific answer' });

      // Fusion puts noise first...
      data.vectorSearch.mockResolvedValue([
        { memory_id: noise.id, score: 0.9 },
        { memory_id: relevant.id, score: 0.7 },
      ]);
      data.memoryGetByIds.mockResolvedValue([noise, relevant]);
      // ...but the cross-encoder scores the relevant one higher
      data.rerank.mockResolvedValue([0.1, 0.98]);

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results[0].memory.id).toBe(relevant.id);
      expect(results[0].score).toBe(0.98);
      expect(results[1].score).toBe(0.1);
    });

    it('date-prefixes texts with validity_start for the reranker', async () => {
      const dated = makeMemory({
        content: 'Camping trip',
        validity_start: '2023-07-01T00:00:00Z',
      });
      data.vectorSearch.mockResolvedValue([{ memory_id: dated.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([dated]);

      await hybridSearch(makeRequest(), data, 'default');

      expect(data.rerank).toHaveBeenCalledWith(expect.any(String), ['[2023-07-01] Camping trip']);
    });

    it('falls back to RRF ordering when the reranker fails', async () => {
      const first = makeMemory({ content: 'First' });
      const second = makeMemory({ content: 'Second' });
      data.vectorSearch.mockResolvedValue([
        { memory_id: first.id, score: 0.9 },
        { memory_id: second.id, score: 0.7 },
      ]);
      data.memoryGetByIds.mockResolvedValue([first, second]);
      data.rerank.mockRejectedValue(new Error('AI unavailable'));

      const results = await hybridSearch(makeRequest(), data, 'default');

      expect(results).toHaveLength(2);
      expect(results[0].memory.id).toBe(first.id);
    });
  });

  // ── error handling ────────────────────────────────────────

  describe('error handling', () => {
    it('throws when embedding generation fails', async () => {
      data.generateEmbeddings.mockResolvedValue([]);

      await expect(hybridSearch(makeRequest(), data, 'default')).rejects.toThrow(
        'Failed to generate query embedding',
      );
    });
  });

  // ── agent-scoped retrieval ────────────────────────────────

  describe('agent scope', () => {
    it('user-only scope: one Vectorize call with user_id filter', async () => {
      await hybridSearch(makeRequest(), data, 'default');

      expect(data.vectorSearch).toHaveBeenCalledTimes(1);
      const filter = data.vectorSearch.mock.calls[0][2] as Record<string, unknown>;
      expect(filter.user_id).toBe('user-1');
      expect(filter.agent_id).toBeUndefined();
      expect(filter.status).toBe('active');
    });

    it('agent-only scope: one Vectorize call with agent_id filter', async () => {
      await hybridSearch(makeRequest({ scope: { agent_id: 'agent-A' } }), data, 'default');

      expect(data.vectorSearch).toHaveBeenCalledTimes(1);
      const filter = data.vectorSearch.mock.calls[0][2] as Record<string, unknown>;
      expect(filter.agent_id).toBe('agent-A');
      expect(filter.user_id).toBeUndefined();
    });

    it('both-set scope: fans out two parallel queries and unions by id', async () => {
      const m1 = makeMemory({ content: 'User hit' });
      const m2 = makeMemory({ content: 'Agent hit' });

      data.vectorSearch
        .mockResolvedValueOnce([{ memory_id: m1.id, score: 0.8 }])
        .mockResolvedValueOnce([{ memory_id: m2.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([m1, m2]);

      const results = await hybridSearch(
        makeRequest({ scope: { user_id: 'user-B', agent_id: 'agent-B' } }),
        data,
        'default',
      );

      expect(data.vectorSearch).toHaveBeenCalledTimes(2);
      const filters = data.vectorSearch.mock.calls.map((c) => c[2]);
      expect(filters).toContainEqual({ user_id: 'user-B', status: 'active' });
      expect(filters).toContainEqual({ agent_id: 'agent-B', status: 'active' });
      expect(results).toHaveLength(2);
    });

    it('both-set scope with shared memory: dedupes by id', async () => {
      const shared = makeMemory({ content: 'Shared', user_id: 'user-B', agent_id: 'agent-B' });

      data.vectorSearch
        .mockResolvedValueOnce([{ memory_id: shared.id, score: 0.7 }])
        .mockResolvedValueOnce([{ memory_id: shared.id, score: 0.9 }]);
      data.memoryGetByIds.mockResolvedValue([shared]);

      const results = await hybridSearch(
        makeRequest({ scope: { user_id: 'user-B', agent_id: 'agent-B' } }),
        data,
        'default',
      );

      // Single result after union (deduped by id).
      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe(shared.id);
    });
  });
});
