import type { Memory } from '@deeprecall/types';
import { buildVectorizeFilters } from '@deeprecall/vectorize';
import type { ScopeKeys } from '@deeprecall/db';
import type { DataService } from '@deeprecall/worker-data';
import { Logger } from '@deeprecall/logger';
import type { RetrievalRequest, ScoredMemoryResult } from './types';
import { rrfFusion, type RankedItem, type FusedResult } from './rrf-fusion';

/**
 * How many candidates to fetch from each source before fusion. Wide on
 * purpose: RRF only needs to get the right memories into the pool — the
 * cross-encoder does the precise ordering. 50 per source keeps the fused
 * pool at least as wide as the rerank window (measured: going wider only
 * added search latency, since the reranker never sees past rank 50).
 */
const POOL_PER_SOURCE = 50;

/**
 * How many fused candidates go through the cross-encoder. One batched
 * Workers AI call scores all of them; misses at RRF ranks 11-50 are
 * exactly what the reranker recovers.
 */
const RERANK_CANDIDATES = 50;

/**
 * Hybrid retrieval funnel: FTS5 + Vectorize → RRF fusion → cross-encoder
 * rerank → top_k. RRF fuses the two arms' incomparable score scales by
 * rank; the cross-encoder then reads query and memory together and
 * produces the real relevance score (in [0,1]) that we return to callers.
 */
export async function hybridSearch(
  request: RetrievalRequest,
  data: Service<DataService>,
  productId: string,
): Promise<ScoredMemoryResult[]> {
  const fetchCount = Math.min(Math.max(request.top_k * 2, POOL_PER_SOURCE), 100);

  // Handle special modes first
  if (request.mode === 'profile') {
    return profileSearch(data, productId, request);
  }

  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (stage: string) => {
    const now = performance.now();
    timings[stage] = Math.round(now - mark);
    mark = now;
  };

  const scopeKeys: ScopeKeys = scopeOf(request.scope);

  // 1+2. FTS5 doesn't need the query embedding, so it starts immediately;
  // the embed → Vectorize chain runs alongside it instead of before it.
  // Vectorize does not support OR within a filter, so user+agent scope
  // requires two parallel queries whose results we union by id.
  const fts5Promise: Promise<Memory[]> = data.memorySearch(
    productId,
    request.query,
    scopeKeys,
    fetchCount,
  );

  const embeddings: number[][] = await data.generateEmbeddings([request.query]);
  const queryEmbedding = embeddings[0] ?? null;
  lap('embed_ms');

  if (!queryEmbedding) {
    throw new Error('Failed to generate query embedding');
  }

  const vectorFilters = buildVectorizeFilters(scopeKeys, { status: 'active' });
  const vectorQueries = vectorFilters.map((filter) =>
    data.vectorSearch(productId, queryEmbedding, filter, fetchCount),
  );

  const [vectorResultsBatches, fts5Memories] = await Promise.all([
    Promise.all(vectorQueries),
    fts5Promise,
  ]);
  lap('search_ms');

  // Union Vectorize results by id, keep best score, preserve best rank.
  const unionedVec = unionByMemoryId(vectorResultsBatches);

  // 3. Fetch full records for Vectorize results from D1.
  //    The D1 hydration query already applies the relaxed scope WHERE
  //    (defense-in-depth against ghost vectors or stale metadata).
  const vecMemoryIds = unionedVec.map((r) => r.memory_id);
  const vecMemories: Memory[] =
    vecMemoryIds.length > 0 ? await data.memoryGetByIds(productId, vecMemoryIds) : [];
  const vecMemoryMap = new Map(vecMemories.map((m) => [m.id, m]));
  lap('hydrate_ms');

  // 4. Build ranked item lists for RRF
  const vectorizeRanked: RankedItem[] = unionedVec
    .map((vr, idx): RankedItem | null => {
      const memory = vecMemoryMap.get(vr.memory_id);
      if (!memory) return null;
      return {
        memory,
        rank: idx + 1,
        originalScore: vr.score,
        source: 'vectorize' as const,
      };
    })
    .filter((item): item is RankedItem => item !== null);

  const fts5Ranked: RankedItem[] = fts5Memories.map((memory: Memory, idx: number) => ({
    memory,
    rank: idx + 1,
    originalScore: 1 / (idx + 1), // FTS5 rank as reciprocal position
    source: 'fts5' as const,
  }));

  // 5. RRF fusion
  let fused = rrfFusion(vectorizeRanked, fts5Ranked);

  // 6. Post-filtering
  fused = postFilter(fused.map((f) => f));

  // 7. Cross-encoder rerank over the fused pool, then cut to top_k.
  let results = await rerankAndCut(fused, request, data);
  lap('rerank_ms');

  // 8. Mode-specific enrichment. Foresight is NOT injected into recall:
  //    foresight memories live in the index and earn their place through
  //    the same funnel as everything else. full_briefing keeps its
  //    explicit "profile + upcoming plans" contract.
  if (request.mode === 'full_briefing') {
    results = await enrichFullBriefing(results, data, productId, request);
  }

  Logger.info(
    Logger.createContext('retrieval', { step: 'hybrid-search-timings' }),
    'Search stage timings',
    { ...timings, pool: fused.length, mode: request.mode },
  );

  return results;
}

/**
 * Score the top fused candidates with the cross-encoder (one batched
 * Workers AI call) and return the best top_k with real relevance scores.
 * Texts are date-prefixed with their validity window start when present so
 * the reranker can weigh temporal fit. Falls back to RRF ordering if the
 * reranker is unavailable — retrieval must degrade, not fail.
 */
async function rerankAndCut(
  fused: FusedResult[],
  request: RetrievalRequest,
  data: Service<DataService>,
): Promise<ScoredMemoryResult[]> {
  const candidates = fused.slice(0, RERANK_CANDIDATES);
  if (candidates.length === 0) return [];

  try {
    const texts = candidates.map((f) => {
      const date = f.memory.validity_start?.slice(0, 10);
      return date ? `[${date}] ${f.memory.content}` : f.memory.content;
    });
    const scores: number[] = await data.rerank(request.query, texts);

    return candidates
      .map((f, i) => ({ memory: f.memory, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, request.top_k);
  } catch (error) {
    console.warn(
      `rerank failed, falling back to RRF ordering: ${error instanceof Error ? error.message : String(error)}`,
    );
    return candidates.slice(0, request.top_k).map((f) => ({ memory: f.memory, score: f.score }));
  }
}

function scopeOf(scope: RetrievalRequest['scope']): ScopeKeys {
  return { user_id: scope.user_id, agent_id: scope.agent_id };
}

/**
 * Union fan-out Vectorize batches by memory_id.
 * Keeps the highest score and preserves the best (lowest) rank across batches.
 */
function unionByMemoryId(
  batches: Array<Array<{ memory_id: string; score: number }>>,
): Array<{ memory_id: string; score: number }> {
  const best = new Map<string, { memory_id: string; score: number }>();
  for (const batch of batches) {
    for (const row of batch) {
      const prev = best.get(row.memory_id);
      if (!prev || row.score > prev.score) {
        best.set(row.memory_id, row);
      }
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score);
}

/**
 * Post-filter: remove non-active memories as defense-in-depth.
 * The upstream sources (Vectorize, FTS5) already filter by status=active,
 * but this ensures consistency even if those filters are loosened.
 */
function postFilter(results: FusedResult[]): FusedResult[] {
  return results.filter((r) => {
    // Remove suppressed, archived, superseded, or expired.
    // Foresight past its validity_end stays retrievable here: a plan whose
    // window has passed is still history the user can ask about. Freshness
    // filtering belongs only in the upcoming-plans injection paths
    // (enrichFullBriefing / enrichRecall), which check validity_end > now.
    return (
      r.memory.status !== 'suppressed' &&
      r.memory.status !== 'archived' &&
      r.memory.status !== 'superseded' &&
      r.memory.status !== 'expired'
    );
  });
}

/**
 * full_briefing mode: includes profile memories and active foresight.
 */
async function enrichFullBriefing(
  results: ScoredMemoryResult[],
  data: Service<DataService>,
  productId: string,
  request: RetrievalRequest,
): Promise<ScoredMemoryResult[]> {
  const existingIds = new Set(results.map((r) => r.memory.id));
  const scope = scopeOf(request.scope);

  // Fetch profile-type memories
  const profiles = await data.memoryListByScope(
    productId,
    { ...scope, type: 'profile', status: 'active' },
    { limit: 5 },
  );

  // Fetch active foresight items
  const foresight = await data.memoryListByScope(
    productId,
    { ...scope, type: 'foresight', status: 'active' },
    { limit: 10 },
  );

  const now = new Date().toISOString();
  const activeForesight = foresight.items.filter(
    (m: Memory) => !m.validity_end || m.validity_end > now,
  );

  // Prepend profile + foresight (high priority) that aren't already in results
  const enriched: ScoredMemoryResult[] = [];

  for (const profile of profiles.items) {
    if (!existingIds.has(profile.id)) {
      enriched.push({ memory: profile, score: 1.0 });
      existingIds.add(profile.id);
    }
  }

  for (const item of activeForesight) {
    if (!existingIds.has(item.id)) {
      enriched.push({ memory: item, score: 0.95 });
      existingIds.add(item.id);
    }
  }

  return [...enriched, ...results];
}

/**
 * profile mode: returns just consolidated profile memories.
 */
async function profileSearch(
  data: Service<DataService>,
  productId: string,
  request: RetrievalRequest,
): Promise<ScoredMemoryResult[]> {
  const scope = scopeOf(request.scope);
  const profiles = await data.memoryListByScope(
    productId,
    { ...scope, type: 'profile', status: 'active' },
    { limit: request.top_k },
  );

  return profiles.items.map((m: Memory) => ({
    memory: m,
    score: 1.0,
  }));
}
