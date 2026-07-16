import { describe, it, expect } from 'vitest';
import {
  chunkText,
  fixedSizeChunk,
  MAX_CHUNK_CHARS,
  OVERLAP_CHARS,
} from '../../src/documents/chunking';

// Characterization tests written BEFORE the C1 extraction: they pin the
// current chunking behavior (paragraph packing, overlap carry-over, forced
// fixed-size splits) so the refactor can be verified as behavior-preserving.

/** Build a paragraph of exactly `len` chars with no '. ' or '\n' inside. */
function para(len: number, fill = 'a'): string {
  return fill.repeat(len);
}

describe('chunkText', () => {
  it('returns a single trimmed chunk for short text', () => {
    expect(chunkText('  hello world  ')).toEqual(['hello world']);
  });

  it('returns a single chunk for text exactly at the limit', () => {
    const text = para(MAX_CHUNK_CHARS);
    expect(chunkText(text)).toEqual([text]);
  });

  it('packs paragraphs into one chunk while they fit', () => {
    const p1 = para(3000);
    const p2 = para(3000, 'b');
    const result = chunkText(`${p1}\n\n${p2}`);
    expect(result).toEqual([`${p1}\n\n${p2}`]);
  });

  it('starts a new chunk at a paragraph boundary and carries overlap from the previous chunk', () => {
    const p1 = para(5000);
    const p2 = para(5000, 'b');
    const result = chunkText(`${p1}\n\n${p2}`);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(p1);
    // Second chunk begins with the last OVERLAP_CHARS of the previous chunk.
    expect(result[1]).toBe(p1.slice(-OVERLAP_CHARS) + '\n\n' + p2);
  });

  it('does not carry overlap when the previous chunk is shorter than the overlap window', () => {
    // First paragraph short (<= OVERLAP_CHARS), second too big to append.
    const p1 = para(400);
    const p2 = para(7900, 'b');
    const result = chunkText(`${p1}\n\n${p2}`);
    expect(result).toEqual([p1, p2]);
  });

  it('force-splits a single paragraph larger than the limit', () => {
    const text = para(20000);
    const result = chunkText(text);
    // fixedSizeChunk windows: [0,8000), [7500,15500), [15000,20000).
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(text.slice(0, 8000));
    expect(result[1]).toBe(text.slice(7500, 15500));
    expect(result[2]).toBe(text.slice(15000, 20000));
  });

  it('never emits a chunk larger than MAX_CHUNK_CHARS', () => {
    const mixed = [para(5000), para(12000, 'b'), para(300, 'c'), para(9000, 'd')].join('\n\n');
    for (const chunk of chunkText(mixed)) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('preserves all distinct paragraph content across chunks', () => {
    const fills = ['a', 'b', 'c', 'd', 'e'];
    const paragraphs = fills.map((f) => para(4000, f));
    const result = chunkText(paragraphs.join('\n\n'));
    const joined = result.join('');
    for (const f of fills) {
      expect(joined).toContain(para(4000, f));
    }
  });
});

describe('fixedSizeChunk', () => {
  it('splits at a sentence boundary when one exists past the midpoint', () => {
    const firstSentence = para(7000) + '. ';
    const rest = para(2000, 'b');
    const result = fixedSizeChunk(firstSentence + rest);
    // Break lands just after the '. ' (breakPoint + 1), trimmed.
    expect(result[0]).toBe((para(7000) + '.').trim());
  });

  it('ignores sentence boundaries before the midpoint', () => {
    const text = para(1000) + '. ' + para(9000, 'b');
    const result = fixedSizeChunk(text);
    // Boundary at 1000 is before start + MAX/2, so the window stays at 8000.
    expect(result[0]!.length).toBe(8000);
  });

  it('overlaps consecutive windows by OVERLAP_CHARS', () => {
    const text = para(10000);
    const result = fixedSizeChunk(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBe(MAX_CHUNK_CHARS);
    // Second window starts OVERLAP_CHARS before the end of the first.
    expect(result[1]).toBe(text.slice(MAX_CHUNK_CHARS - OVERLAP_CHARS));
  });
});
