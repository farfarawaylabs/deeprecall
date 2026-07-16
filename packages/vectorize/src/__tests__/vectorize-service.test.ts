import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareVectorizeService } from '../vectorize-service';
import type { VectorMetadata, VectorSearchFilters } from '../types';

function createMockIndex() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    // Other VectorizeIndex methods (not used by our service)
    getByIds: vi.fn(),
    describe: vi.fn(),
    insert: vi.fn(),
  } as unknown as VectorizeIndex;
}

const testEmbedding = Array.from({ length: 1024 }, (_, i) => i * 0.001);

const testMetadata: VectorMetadata = {
  user_id: 'user-1',
  type: 'fact',
  status: 'active',
  source_type: 'user_stated',
  confidence: 0.9,
};

describe('CloudflareVectorizeService', () => {
  let mockIndex: ReturnType<typeof createMockIndex>;
  let service: CloudflareVectorizeService;

  beforeEach(() => {
    mockIndex = createMockIndex();
    service = new CloudflareVectorizeService(mockIndex as VectorizeIndex);
  });

  // ── upsert ──────────────────────────────────────────────────

  describe('upsert', () => {
    it('calls index.upsert with correct vector structure', async () => {
      await service.upsert('mem-1', testEmbedding, testMetadata);

      expect(mockIndex.upsert).toHaveBeenCalledOnce();
      expect(mockIndex.upsert).toHaveBeenCalledWith([
        {
          id: 'mem-1',
          values: testEmbedding,
          metadata: testMetadata,
        },
      ]);
    });

    it('passes metadata fields correctly', async () => {
      const metadata: VectorMetadata = {
        user_id: 'user-42',
        type: 'foresight',
        status: 'active',
        source_type: 'agent_inferred',
        confidence: 0.75,
      };

      await service.upsert('mem-2', testEmbedding, metadata);

      const call = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
      expect(call.metadata.user_id).toBe('user-42');
      expect(call.metadata.type).toBe('foresight');
      expect(call.metadata.source_type).toBe('agent_inferred');
      expect(call.metadata.confidence).toBe(0.75);
    });

    it('agent-only upsert: omits user_id key entirely (never writes null)', async () => {
      const metadata: VectorMetadata = {
        agent_id: 'agent-1',
        type: 'fact',
        status: 'active',
        source_type: 'user_stated',
        confidence: 0.9,
      };

      await service.upsert('mem-agent', testEmbedding, metadata);

      const call = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
      expect(call.metadata.agent_id).toBe('agent-1');
      expect('user_id' in call.metadata).toBe(false);
    });

    it('user-only upsert: omits agent_id key entirely', async () => {
      await service.upsert('mem-user', testEmbedding, testMetadata);

      const call = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
      expect('agent_id' in call.metadata).toBe(false);
      expect(call.metadata.user_id).toBe('user-1');
    });
  });

  // ── search ──────────────────────────────────────────────────

  describe('search', () => {
    it('queries index and maps results', async () => {
      (mockIndex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: 'mem-1', score: 0.95 },
          { id: 'mem-2', score: 0.82 },
        ],
        count: 2,
      });

      const results = await service.search(testEmbedding, { user_id: 'user-1' }, 10);

      expect(results).toEqual([
        { memory_id: 'mem-1', score: 0.95 },
        { memory_id: 'mem-2', score: 0.82 },
      ]);
    });

    it('passes all filter fields to query', async () => {
      const filters: VectorSearchFilters = {
        user_id: 'user-1',
        status: 'active',
        type: 'fact',
      };

      await service.search(testEmbedding, filters, 5);

      expect(mockIndex.query).toHaveBeenCalledWith(testEmbedding, {
        topK: 5,
        filter: {
          user_id: 'user-1',
          status: 'active',
          type: 'fact',
        },
      });
    });

    it('omits undefined filter fields', async () => {
      await service.search(testEmbedding, { user_id: 'user-1' }, 10);

      const callArgs = (mockIndex.query as ReturnType<typeof vi.fn>).mock.calls[0];
      const filter = callArgs[1].filter;
      expect(filter).toEqual({ user_id: 'user-1' });
      expect(filter).not.toHaveProperty('status');
      expect(filter).not.toHaveProperty('type');
    });

    it('passes empty filter when no filters provided', async () => {
      await service.search(testEmbedding, {}, 10);

      const callArgs = (mockIndex.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].filter).toEqual({});
    });

    it('returns empty array when no matches', async () => {
      const results = await service.search(testEmbedding, {}, 10);
      expect(results).toEqual([]);
    });

    it('respects topK parameter', async () => {
      await service.search(testEmbedding, {}, 25);

      expect(mockIndex.query).toHaveBeenCalledWith(testEmbedding, {
        topK: 25,
        filter: {},
      });
    });
  });

  // ── delete ──────────────────────────────────────────────────

  describe('delete', () => {
    it('calls deleteByIds with single-element array', async () => {
      await service.delete('mem-1');

      expect(mockIndex.deleteByIds).toHaveBeenCalledOnce();
      expect(mockIndex.deleteByIds).toHaveBeenCalledWith(['mem-1']);
    });
  });

  // ── upsertMany ──────────────────────────────────────────────

  describe('upsertMany', () => {
    it('writes all vectors in one index.upsert call', async () => {
      await service.upsertMany([
        { memoryId: 'mem-1', embedding: testEmbedding, metadata: testMetadata },
        { memoryId: 'mem-2', embedding: testEmbedding, metadata: testMetadata },
      ]);

      expect(mockIndex.upsert).toHaveBeenCalledOnce();
      const vectors = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(vectors.map((v: { id: string }) => v.id)).toEqual(['mem-1', 'mem-2']);
    });

    it('skips call for empty array', async () => {
      await service.upsertMany([]);

      expect(mockIndex.upsert).not.toHaveBeenCalled();
    });

    it('batches into chunks of 100', async () => {
      const items = Array.from({ length: 207 }, (_, i) => ({
        memoryId: `mem-${i}`,
        embedding: testEmbedding,
        metadata: testMetadata,
      }));
      await service.upsertMany(items);

      const calls = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toHaveLength(100);
      expect(calls[1][0]).toHaveLength(100);
      expect(calls[2][0]).toHaveLength(7);
    });

    it('omits unset scope keys from metadata (never writes null)', async () => {
      await service.upsertMany([
        {
          memoryId: 'mem-1',
          embedding: testEmbedding,
          metadata: {
            agent_id: 'agent-1',
            type: 'fact',
            status: 'active',
            source_type: 'user_stated',
            confidence: 0.9,
          },
        },
      ]);

      const vector = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0];
      expect(vector.metadata.agent_id).toBe('agent-1');
      expect('user_id' in vector.metadata).toBe(false);
    });
  });

  // ── deleteMany ──────────────────────────────────────────────

  describe('deleteMany', () => {
    it('calls deleteByIds with all provided IDs', async () => {
      await service.deleteMany(['mem-1', 'mem-2', 'mem-3']);

      expect(mockIndex.deleteByIds).toHaveBeenCalledOnce();
      expect(mockIndex.deleteByIds).toHaveBeenCalledWith(['mem-1', 'mem-2', 'mem-3']);
    });

    it('skips call for empty array', async () => {
      await service.deleteMany([]);

      expect(mockIndex.deleteByIds).not.toHaveBeenCalled();
    });

    it('batches into chunks of 100 (Vectorize deleteByIds limit)', async () => {
      const ids = Array.from({ length: 207 }, (_, i) => `mem-${i}`);
      await service.deleteMany(ids);

      const calls = (mockIndex.deleteByIds as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toHaveLength(100);
      expect(calls[1][0]).toHaveLength(100);
      expect(calls[2][0]).toHaveLength(7);
      expect(calls.flatMap((c) => c[0])).toEqual(ids);
    });
  });
});
