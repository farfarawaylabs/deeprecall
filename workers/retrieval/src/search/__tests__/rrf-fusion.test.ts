import { describe, it, expect } from 'vitest';
import { rrfFusion, type RankedItem } from '../rrf-fusion';
import type { Memory } from '@deeprecall/types';

/** Helper to make a minimal Memory for testing. */
function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    content: `Content for ${id}`,
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
    observed_at: '2026-04-13T00:00:00Z',
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
    superseded_by: null,
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

describe('RRF Fusion', () => {
  it('handles empty inputs', () => {
    expect(rrfFusion([], [])).toEqual([]);
  });

  it('handles vectorize-only results', () => {
    const vecResults: RankedItem[] = [
      { memory: makeMemory('m1'), rank: 1, originalScore: 0.95, source: 'vectorize' },
      { memory: makeMemory('m2'), rank: 2, originalScore: 0.85, source: 'vectorize' },
    ];
    const results = rrfFusion(vecResults, []);
    expect(results).toHaveLength(2);
    expect(results[0].memory.id).toBe('m1');
    expect(results[1].memory.id).toBe('m2');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('handles fts5-only results', () => {
    const ftsResults: RankedItem[] = [
      { memory: makeMemory('m1'), rank: 1, originalScore: 1, source: 'fts5' },
    ];
    const results = rrfFusion([], ftsResults);
    expect(results).toHaveLength(1);
    expect(results[0].memory.id).toBe('m1');
    expect(results[0].sources).toHaveLength(1);
    expect(results[0].sources[0].source).toBe('fts5');
  });

  it('boosts items appearing in both lists', () => {
    const sharedMemory = makeMemory('shared');
    const vecOnly = makeMemory('vec-only');
    const ftsOnly = makeMemory('fts-only');

    const vecResults: RankedItem[] = [
      { memory: sharedMemory, rank: 1, originalScore: 0.95, source: 'vectorize' },
      { memory: vecOnly, rank: 2, originalScore: 0.85, source: 'vectorize' },
    ];
    const ftsResults: RankedItem[] = [
      { memory: sharedMemory, rank: 1, originalScore: 1, source: 'fts5' },
      { memory: ftsOnly, rank: 2, originalScore: 0.5, source: 'fts5' },
    ];

    const results = rrfFusion(vecResults, ftsResults);

    // The shared memory should be ranked first (appears in both lists)
    expect(results[0].memory.id).toBe('shared');
    expect(results[0].sources).toHaveLength(2);

    // Its score should be the sum of both RRF contributions
    const expectedScore = (1 / (60 + 1) + 1 / (60 + 1)) * 1.05; // confidence=0.8, boost 1.05
    expect(results[0].score).toBeCloseTo(expectedScore, 6);
  });

  it('applies RRF formula correctly: score = 1/(k+rank)', () => {
    const vecResults: RankedItem[] = [
      {
        memory: makeMemory('m1', { confidence: 0.75 }),
        rank: 1,
        originalScore: 0.9,
        source: 'vectorize',
      },
    ];
    const results = rrfFusion(vecResults, []);

    // k=60, rank=1, no confidence boost/penalty for 0.75
    const expected = 1 / (60 + 1);
    expect(results[0].score).toBeCloseTo(expected, 6);
  });

  it('boosts high-confidence memories (>= 0.9)', () => {
    const highConf = makeMemory('high', { confidence: 0.95 });
    const normalConf = makeMemory('normal', { confidence: 0.75 });

    const vecResults: RankedItem[] = [
      { memory: normalConf, rank: 1, originalScore: 0.9, source: 'vectorize' },
      { memory: highConf, rank: 2, originalScore: 0.8, source: 'vectorize' },
    ];

    const results = rrfFusion(vecResults, []);

    // High-conf at rank 2 gets 1.1x boost = (1/62)*1.1 = 0.01774
    // Normal at rank 1 gets no boost = 1/61 = 0.01639
    // So high-conf memory sorts first despite lower rank
    const highScore = (1 / (60 + 2)) * 1.1;
    const normalScore = 1 / (60 + 1);

    expect(results[0].memory.id).toBe('high');
    expect(results[0].score).toBeCloseTo(highScore, 6);
    expect(results[1].memory.id).toBe('normal');
    expect(results[1].score).toBeCloseTo(normalScore, 6);
  });

  it('penalizes low-confidence memories (< 0.5)', () => {
    const lowConf = makeMemory('low', { confidence: 0.3 });

    const vecResults: RankedItem[] = [
      { memory: lowConf, rank: 1, originalScore: 0.9, source: 'vectorize' },
    ];

    const results = rrfFusion(vecResults, []);
    const expected = (1 / (60 + 1)) * 0.9;
    expect(results[0].score).toBeCloseTo(expected, 6);
  });

  it('sorts by fused score descending', () => {
    const m1 = makeMemory('m1');
    const m2 = makeMemory('m2');
    const m3 = makeMemory('m3');

    // m3 appears in both lists, should rank highest after fusion
    const vecResults: RankedItem[] = [
      { memory: m1, rank: 1, originalScore: 0.9, source: 'vectorize' },
      { memory: m3, rank: 2, originalScore: 0.8, source: 'vectorize' },
    ];
    const ftsResults: RankedItem[] = [
      { memory: m2, rank: 1, originalScore: 1, source: 'fts5' },
      { memory: m3, rank: 2, originalScore: 0.5, source: 'fts5' },
    ];

    const results = rrfFusion(vecResults, ftsResults);
    // m3 appears in both: score = 1/(60+2) + 1/(60+2) with 1.05 boost
    // m1 vec only: 1/(60+1) with 1.05 boost
    // m2 fts only: 1/(60+1) with 1.05 boost
    expect(results[0].memory.id).toBe('m3');
  });

  it('deduplicates memories across sources', () => {
    const shared = makeMemory('m1');

    const vecResults: RankedItem[] = [
      { memory: shared, rank: 1, originalScore: 0.9, source: 'vectorize' },
    ];
    const ftsResults: RankedItem[] = [
      { memory: shared, rank: 3, originalScore: 0.7, source: 'fts5' },
    ];

    const results = rrfFusion(vecResults, ftsResults);
    expect(results).toHaveLength(1); // Not duplicated
    expect(results[0].sources).toHaveLength(2);
  });
});
