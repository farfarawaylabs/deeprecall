import { describe, it, expect, vi } from 'vitest';
import { embed } from '../../src/steps/embed';
import type { MemoryCandidate } from '@deeprecall/types';

function makeCandidate(content: string): MemoryCandidate {
  return {
    content,
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
  };
}

describe('embed', () => {
  it('returns empty array for empty candidates', async () => {
    const data = { generateEmbeddings: vi.fn() };
    const result = await embed([], data);
    expect(result).toEqual([]);
    expect(data.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('pairs each candidate with its embedding', async () => {
    const candidates = [makeCandidate('Fact A'), makeCandidate('Fact B')];
    const mockEmbeddings = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    const data = {
      generateEmbeddings: vi.fn().mockResolvedValue(mockEmbeddings),
    };

    const result = await embed(candidates, data);

    expect(result).toHaveLength(2);
    expect(result[0].candidate.content).toBe('Fact A');
    expect(result[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result[1].candidate.content).toBe('Fact B');
    expect(result[1].embedding).toEqual([0.4, 0.5, 0.6]);
  });

  it('passes candidate contents as texts', async () => {
    const candidates = [makeCandidate('Hello'), makeCandidate('World')];
    const data = {
      generateEmbeddings: vi.fn().mockResolvedValue([[1], [2]]),
    };

    await embed(candidates, data);

    expect(data.generateEmbeddings).toHaveBeenCalledWith(['Hello', 'World']);
  });

  it('throws on embedding count mismatch', async () => {
    const candidates = [makeCandidate('A'), makeCandidate('B')];
    const data = {
      generateEmbeddings: vi.fn().mockResolvedValue([[1]]), // Only 1 embedding for 2 candidates
    };

    await expect(embed(candidates, data)).rejects.toThrow('Embedding count mismatch');
  });
});
