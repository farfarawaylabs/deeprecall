import { describe, it, expect } from 'vitest';
import type { Memory } from '@deeprecall/types';
import type { DataService } from '@deeprecall/worker-data';
import { findSimilarMemories } from '../../src/reconcile/similar-memories';

function mem(id: string): Memory {
  return {
    id,
    content: `content of ${id}`,
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'u1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'inferred',
    source_channel: 'chat',
    confidence: 0.7,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    superseded_by: null,
    tags: null,
    subject: null,
    predicate: null,
    object: null,
  } as Memory;
}

/**
 * Fake DATA where each vectorSearch call pops the next configured batch —
 * one batch per filter variant produced by buildVectorizeFilters.
 */
function fakeData(batches: Array<Array<{ memory_id: string; score: number }>>, rows: Memory[]) {
  let call = 0;
  const searchedFilters: unknown[] = [];
  return {
    searchedFilters,
    async vectorSearch(_p: string, _e: number[], filter: unknown, _k: number) {
      searchedFilters.push(filter);
      return batches[call++] ?? [];
    },
    async memoryGetByIds(_p: string, ids: string[]) {
      return rows.filter((r) => ids.includes(r.id));
    },
  };
}

const asData = (f: object) => f as unknown as Service<DataService>;
const EMBEDDING = [0.1, 0.2];

describe('findSimilarMemories', () => {
  it('unions variant results keeping the best score per memory, sorted desc', async () => {
    // A dual-key scope produces one filter variant per key (user_id,
    // agent_id), so two search batches to union.
    const data = fakeData(
      [
        [
          { memory_id: 'm1', score: 0.8 },
          { memory_id: 'm2', score: 0.6 },
        ],
        [
          { memory_id: 'm1', score: 0.9 }, // better score for m1 in another variant
          { memory_id: 'm3', score: 0.7 },
        ],
      ],
      [mem('m1'), mem('m2'), mem('m3')],
    );

    const result = await findSimilarMemories(
      asData(data),
      'p1',
      EMBEDDING,
      { user_id: 'u1', agent_id: 'ag1' },
      5,
    );
    expect(data.searchedFilters).toHaveLength(2);

    expect(result.map((r) => [r.memory.id, r.score])).toEqual([
      ['m1', 0.9],
      ['m3', 0.7],
      ['m2', 0.6],
    ]);
  });

  it('truncates to topK after the union', async () => {
    const data = fakeData(
      [
        [
          { memory_id: 'm1', score: 0.9 },
          { memory_id: 'm2', score: 0.8 },
          { memory_id: 'm3', score: 0.7 },
        ],
      ],
      [mem('m1'), mem('m2'), mem('m3')],
    );
    const result = await findSimilarMemories(asData(data), 'p1', EMBEDDING, { user_id: 'u1' }, 2);
    expect(result.map((r) => r.memory.id)).toEqual(['m1', 'm2']);
  });

  it('drops ghost vectors whose D1 row no longer exists', async () => {
    const data = fakeData(
      [
        [
          { memory_id: 'ghost', score: 0.95 },
          { memory_id: 'm1', score: 0.5 },
        ],
      ],
      [mem('m1')], // 'ghost' has no backing row
    );
    const result = await findSimilarMemories(asData(data), 'p1', EMBEDDING, { user_id: 'u1' }, 5);
    expect(result.map((r) => r.memory.id)).toEqual(['m1']);
  });

  it('returns empty without hydrating when no vectors match', async () => {
    let hydrated = false;
    const data = {
      async vectorSearch() {
        return [];
      },
      async memoryGetByIds() {
        hydrated = true;
        return [];
      },
    };
    const result = await findSimilarMemories(asData(data), 'p1', EMBEDDING, { user_id: 'u1' }, 5);
    expect(result).toEqual([]);
    expect(hydrated).toBe(false);
  });

  it('searches with active-status filters for every scope variant', async () => {
    const data = fakeData([[], []], []);
    await findSimilarMemories(asData(data), 'p1', EMBEDDING, { user_id: 'u1', agent_id: 'ag1' }, 5);
    // Every emitted filter variant carries the status:active constraint.
    expect(data.searchedFilters.length).toBeGreaterThan(0);
    for (const filter of data.searchedFilters) {
      expect(filter).toMatchObject({ status: 'active' });
    }
  });
});
