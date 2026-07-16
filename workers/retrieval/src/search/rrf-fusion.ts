import type { Memory } from '@deeprecall/types';

/** Standard RRF constant. */
const RRF_K = 60;

export interface RankedItem {
  memory: Memory;
  /** Rank within its source list (1-indexed). */
  rank: number;
  /** Original score from the source (for logging/debugging). */
  originalScore: number;
  /** Source system that produced this ranking. */
  source: 'vectorize' | 'fts5';
}

export interface FusedResult {
  memory: Memory;
  /** Combined RRF score. */
  score: number;
  /** Breakdown of scores per source. */
  sources: Array<{
    source: 'vectorize' | 'fts5';
    rank: number;
    originalScore: number;
  }>;
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from FTS5 and Vectorize.
 * score(d) = SUM( 1 / (k + rank_i(d)) ) for each list i where d appears.
 *
 * @param vectorizeResults - Ranked results from Vectorize (semantic search)
 * @param fts5Results - Ranked results from D1 FTS5 (keyword search)
 * @returns Fused and re-ranked results
 */
export function rrfFusion(
  vectorizeResults: RankedItem[],
  fts5Results: RankedItem[],
): FusedResult[] {
  const fusionMap = new Map<
    string,
    {
      memory: Memory;
      rrfScore: number;
      sources: FusedResult['sources'];
    }
  >();

  // Process Vectorize results
  for (const item of vectorizeResults) {
    const rrfScore = 1 / (RRF_K + item.rank);
    fusionMap.set(item.memory.id, {
      memory: item.memory,
      rrfScore,
      sources: [
        {
          source: 'vectorize',
          rank: item.rank,
          originalScore: item.originalScore,
        },
      ],
    });
  }

  // Process FTS5 results (add to existing or create new)
  for (const item of fts5Results) {
    const rrfScore = 1 / (RRF_K + item.rank);
    const existing = fusionMap.get(item.memory.id);

    if (existing) {
      existing.rrfScore += rrfScore;
      existing.sources.push({
        source: 'fts5',
        rank: item.rank,
        originalScore: item.originalScore,
      });
    } else {
      fusionMap.set(item.memory.id, {
        memory: item.memory,
        rrfScore,
        sources: [
          {
            source: 'fts5',
            rank: item.rank,
            originalScore: item.originalScore,
          },
        ],
      });
    }
  }

  // Apply confidence boosting
  const results: FusedResult[] = [];
  for (const [, entry] of fusionMap) {
    let adjustedScore = entry.rrfScore;

    // Boost high-confidence memories slightly
    if (entry.memory.confidence >= 0.9) {
      adjustedScore *= 1.1;
    } else if (entry.memory.confidence >= 0.8) {
      adjustedScore *= 1.05;
    }

    // Penalize low-confidence memories
    if (entry.memory.confidence < 0.5) {
      adjustedScore *= 0.9;
    }

    results.push({
      memory: entry.memory,
      score: adjustedScore,
      sources: entry.sources,
    });
  }

  // Sort by fused score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}
