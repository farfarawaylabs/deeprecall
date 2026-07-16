import { describe, it, expect, vi } from 'vitest';
import { makeService } from './helpers';

// Miniflare has no local simulator for Vectorize or Workers AI (both are
// remote-proxy only), so these paths are exercised by constructing the
// DataService directly with stub bindings. The D1/R2 paths use real local
// bindings over RPC in the other test files.

function makeVectorizeStub() {
  return {
    upsert: vi.fn().mockResolvedValue({ mutationId: 'm1' }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: 'm2' }),
    query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
  };
}

describe('vector facade (stubbed Vectorize binding)', () => {
  it('vectorDeleteMany splits ids into batches of at most 100', async () => {
    const stub = makeVectorizeStub();
    const svc = makeService({ VEC_default: stub });

    const ids = Array.from({ length: 250 }, (_, i) => `mem-${i}`);
    await svc.vectorDeleteMany('default', ids);

    expect(stub.deleteByIds).toHaveBeenCalledTimes(3);
    expect(stub.deleteByIds.mock.calls[0][0]).toHaveLength(100);
    expect(stub.deleteByIds.mock.calls[1][0]).toHaveLength(100);
    expect(stub.deleteByIds.mock.calls[2][0]).toHaveLength(50);
    expect(stub.deleteByIds.mock.calls[2][0][0]).toBe('mem-200');
  });

  it('vectorDelete removes a single id', async () => {
    const stub = makeVectorizeStub();
    const svc = makeService({ VEC_default: stub });

    await svc.vectorDelete('default', 'mem-9');
    expect(stub.deleteByIds).toHaveBeenCalledExactlyOnceWith(['mem-9']);
  });

  it('vectorUpsertMany batches and cleans null scope keys from metadata', async () => {
    const stub = makeVectorizeStub();
    const svc = makeService({ VEC_default: stub });

    const items = Array.from({ length: 150 }, (_, i) => ({
      memoryId: `mem-${i}`,
      embedding: [0.1, 0.2],
      metadata: {
        type: 'fact' as const,
        status: 'active' as const,
        source_type: 'user_stated' as const,
        confidence: 0.9,
        user_id: null,
        agent_id: 'agent-1',
      },
    }));
    await svc.vectorUpsertMany('default', items);

    expect(stub.upsert).toHaveBeenCalledTimes(2);
    expect(stub.upsert.mock.calls[0][0]).toHaveLength(100);
    const first = stub.upsert.mock.calls[0][0][0];
    expect(first.id).toBe('mem-0');
    // Null user_id must be OMITTED (not null) or it poisons metadata filters.
    expect('user_id' in first.metadata).toBe(false);
    expect(first.metadata.agent_id).toBe('agent-1');
  });

  it('vectorSearch maps matches to memory_id/score pairs and builds filters', async () => {
    const stub = makeVectorizeStub();
    stub.query.mockResolvedValue({
      matches: [
        { id: 'mem-1', score: 0.92 },
        { id: 'mem-2', score: 0.81 },
      ],
      count: 2,
    });
    const svc = makeService({ VEC_default: stub });

    const results = await svc.vectorSearch('default', [0.1], { user_id: 'u1' }, 5);
    expect(results).toEqual([
      { memory_id: 'mem-1', score: 0.92 },
      { memory_id: 'mem-2', score: 0.81 },
    ]);
    expect(stub.query).toHaveBeenCalledWith([0.1], { topK: 5, filter: { user_id: 'u1' } });
  });
});

describe('AI facade (stubbed AI binding)', () => {
  it('generateEmbeddings returns the model data array', async () => {
    const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] });
    const svc = makeService({ AI: { run } });

    const embeddings = await svc.generateEmbeddings(['hello']);
    expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['hello'] });
  });

  it('generateEmbeddings returns [] when the model yields no data', async () => {
    const run = vi.fn().mockResolvedValue({});
    const svc = makeService({ AI: { run } });
    expect(await svc.generateEmbeddings(['hello'])).toEqual([]);
  });

  describe('rerank', () => {
    it('returns [] for empty input without calling the model', async () => {
      const run = vi.fn();
      const svc = makeService({ AI: { run } });
      expect(await svc.rerank('query', [])).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    });

    it('aligns sigmoid scores by row id, defaulting missing rows to 0', async () => {
      // Rows arrive out of order and one input (index 1) has no row at all.
      const run = vi.fn().mockResolvedValue({
        response: [
          { id: 2, score: 0 },
          { id: 0, score: 100 },
        ],
      });
      const svc = makeService({ AI: { run } });

      const scores = await svc.rerank('query', ['a', 'b', 'c']);
      expect(scores).toHaveLength(3);
      expect(scores[0]).toBeCloseTo(1, 5); // sigmoid(100) ≈ 1
      expect(scores[1]).toBe(0); // missing row → 0
      expect(scores[2]).toBeCloseTo(0.5, 5); // sigmoid(0) = 0.5
      expect(run).toHaveBeenCalledWith('@cf/baai/bge-reranker-base', {
        query: 'query',
        contexts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      });
    });
  });
});
