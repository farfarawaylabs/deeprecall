import type { SimilarMemory } from '@deeprecall/ai';
import { buildVectorizeFilters } from '@deeprecall/vectorize';
import type { DataService } from '@deeprecall/worker-data';

/**
 * Find the active memories most similar to an embedding within a scope.
 *
 * Mirrors the reconcile step of the ingestion pipeline: fan the search out
 * across the scope's Vectorize filter variants, union the results keeping
 * each memory's best score, then hydrate the top-k from D1. Vectors whose
 * D1 row is missing are dropped (ghost-vector defense — Vectorize results
 * must never be acted on without a backing row).
 */
export async function findSimilarMemories(
  data: Service<DataService>,
  productId: string,
  embedding: number[],
  scope: { user_id?: string; agent_id?: string },
  topK: number,
): Promise<SimilarMemory[]> {
  const variants = buildVectorizeFilters(scope, { status: 'active' });
  const batches = await Promise.all(
    variants.map((f) => data.vectorSearch(productId, embedding, f, topK)),
  );

  const bestById = new Map<string, { memory_id: string; score: number }>();
  for (const batch of batches) {
    for (const row of batch) {
      const prev = bestById.get(row.memory_id);
      if (!prev || row.score > prev.score) bestById.set(row.memory_id, row);
    }
  }
  const vectorResults = Array.from(bestById.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const memoryIds = vectorResults.map((r) => r.memory_id);
  const existingMemories =
    memoryIds.length > 0 ? await data.memoryGetByIds(productId, memoryIds) : [];

  return vectorResults
    .map((vr) => {
      const memory = existingMemories.find((m) => m.id === vr.memory_id);
      if (!memory) return null;
      return { memory, score: vr.score };
    })
    .filter((sm): sm is SimilarMemory => sm !== null);
}
