import { type ClaudeConfig, reconcileCandidate, type SimilarMemory } from '@deeprecall/ai';
import type { Memory, Scope } from '@deeprecall/types';
import { buildVectorizeFilters } from '@deeprecall/vectorize';
import type { EmbeddedCandidate, ReconcileDecision } from '../types';

/** Below this score we don't even consider an existing memory as related. */
const SIMILARITY_THRESHOLD = 0.6;

/**
 * Above this score, auto-SKIP without calling the LLM.
 * Set high deliberately: with BGE-M3, contradicting updates to the same
 * fact ("pets are Luna and Oliver" vs "pets are Oliver, Bailey and a
 * horse") routinely score 0.85–0.95, and auto-skipping them silently
 * drops the update. Only near-verbatim paraphrases clear 0.95.
 */
const AUTO_SKIP_THRESHOLD = 0.95;

/** Max existing memories to compare each candidate against. */
const MAX_SIMILAR_MEMORIES = 5;

/**
 * How many recent same-scope memories to fetch from D1 as additional
 * reconciliation candidates. Vectorize is eventually consistent, so during
 * a bulk import (e.g. onboarding a conversation history) memories persisted
 * seconds ago are invisible to vectorSearch — D1 sees them immediately.
 */
const RECENT_MEMORY_LIMIT = 30;

export interface ReconcileEnv {
  data: {
    vectorSearch(
      productId: string,
      embedding: number[],
      filters: { user_id?: string; agent_id?: string; status?: string; type?: string },
      topK: number,
    ): Promise<{ memory_id: string; score: number }[]>;
    memoryGetByIds(productId: string, ids: string[]): Promise<Memory[]>;
    memoryListByScope(
      productId: string,
      filters: { user_id?: string; agent_id?: string; status?: string },
      pagination: { limit: number },
    ): Promise<{ items: Memory[] }>;
    generateEmbeddings(texts: string[]): Promise<number[][]>;
  };
  productId: string;
  claude: ClaudeConfig;
  scope: Scope;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Step 5: Reconcile candidates against existing memories.
 * For each candidate:
 * 1. Search Vectorize for semantically similar active memories
 * 2. Verify matches exist in D1 (guards against ghost vectors after purge)
 * 3. If very high similarity to a verified memory, auto-SKIP without LLM
 * 4. If moderate similarity, call LLM to decide action
 * 5. If no verified similar memories, automatically ADD
 */
export async function reconcile(
  candidates: EmbeddedCandidate[],
  env: ReconcileEnv,
): Promise<ReconcileDecision[]> {
  const decisions: ReconcileDecision[] = [];

  // Fan out per scope key (user_id / agent_id). Vectorize can't OR within
  // a filter, so scopes carrying both keys require two parallel queries
  // unioned by id. Relaxed matching happens implicitly — each filter
  // returns memories where that specific key equals the scope, which
  // is the same set hybridSearch surfaces for retrieval.
  const filterVariants = buildVectorizeFilters(
    { user_id: env.scope.user_id, agent_id: env.scope.agent_id },
    { status: 'active' },
  );

  // Second candidate arm: the most recently created same-scope memories,
  // straight from D1. Vectorize hasn't necessarily indexed them yet (bulk
  // imports persist memories seconds apart), so without this arm reconcile
  // is blind exactly when duplicates and contradictions are most likely.
  // Fetched and embedded once per run, reused for every candidate.
  const recent = await env.data.memoryListByScope(
    env.productId,
    {
      user_id: env.scope.user_id,
      agent_id: env.scope.agent_id,
      status: 'active',
    },
    { limit: RECENT_MEMORY_LIMIT },
  );
  const recentMemories = recent.items;
  const recentEmbeddings =
    recentMemories.length > 0
      ? await env.data.generateEmbeddings(recentMemories.map((m) => m.content))
      : [];

  for (const ec of candidates) {
    // Search for similar existing memories using the candidate's embedding
    const batches = await Promise.all(
      filterVariants.map((filter) =>
        env.data.vectorSearch(env.productId, ec.embedding, filter, MAX_SIMILAR_MEMORIES),
      ),
    );

    // Union batches by memory_id, keeping best score.
    const best = new Map<string, { memory_id: string; score: number }>();
    for (const batch of batches) {
      for (const row of batch) {
        const prev = best.get(row.memory_id);
        if (!prev || row.score > prev.score) best.set(row.memory_id, row);
      }
    }

    // Merge in the D1 recent-memory arm, keeping the best score per id.
    for (let i = 0; i < recentMemories.length; i++) {
      const embedding = recentEmbeddings[i];
      if (!embedding) continue;
      const score = cosineSimilarity(ec.embedding, embedding);
      const row = { memory_id: recentMemories[i].id, score };
      const prev = best.get(row.memory_id);
      if (!prev || row.score > prev.score) best.set(row.memory_id, row);
    }

    const vectorResults = Array.from(best.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SIMILAR_MEMORIES);

    // Filter to only those above the similarity threshold
    const aboveThreshold = vectorResults.filter((r) => r.score >= SIMILARITY_THRESHOLD);

    if (aboveThreshold.length === 0) {
      decisions.push({
        action: 'add',
        candidate: ec,
        reason: 'No similar existing memories found',
      });
      continue;
    }

    // Fetch full memory records from D1 to verify they still exist.
    // Vectorize is eventually consistent — vectors may linger after
    // a memory is deleted or purged (ghost vectors).
    const memoryIds = aboveThreshold.map((r) => r.memory_id);
    const memories = await env.data.memoryGetByIds(env.productId, memoryIds);

    // Build SimilarMemory array with scores, dropping ghost vectors
    const similarMemories: SimilarMemory[] = aboveThreshold
      .map((vr) => {
        const memory = memories.find((m) => m.id === vr.memory_id);
        if (!memory) return null;
        return { memory, score: vr.score };
      })
      .filter((sm): sm is SimilarMemory => sm !== null);

    // If all vector matches were ghost vectors, ADD
    if (similarMemories.length === 0) {
      decisions.push({
        action: 'add',
        candidate: ec,
        reason: 'Similar vectors found but no matching records in D1 (ghost vectors after purge)',
      });
      continue;
    }

    // Auto-SKIP: if the best D1-verified match has very high similarity,
    // it's a paraphrase of the same fact — skip without LLM call
    const bestVerified = similarMemories[0];
    if (bestVerified.score >= AUTO_SKIP_THRESHOLD) {
      decisions.push({
        action: 'skip',
        candidate: ec,
        existing_memory_id: bestVerified.memory.id,
        reason: `Auto-skipped: existing memory has ${(bestVerified.score * 100).toFixed(1)}% similarity (threshold: ${AUTO_SKIP_THRESHOLD * 100}%)`,
      });
      continue;
    }

    // Check if any similar memory is pinned (user_stated with confidence 1.0)
    // Pinned memories are immune to auto-supersede
    const hasPinnedConflict = similarMemories.some(
      (sm) =>
        sm.memory.source_type === 'user_stated' &&
        sm.memory.confidence === 1.0 &&
        ec.candidate.source_type === 'agent_inferred',
    );

    if (hasPinnedConflict) {
      decisions.push({
        action: 'skip',
        candidate: ec,
        reason:
          'Existing pinned memory (user_stated, confidence=1.0) takes precedence over agent-inferred candidate',
        existing_memory_id: similarMemories.find(
          (sm) => sm.memory.source_type === 'user_stated' && sm.memory.confidence === 1.0,
        )?.memory.id,
      });
      continue;
    }

    // Call LLM to decide the reconciliation action
    const llmDecision = await reconcileCandidate(ec.candidate, similarMemories, {
      claude: env.claude,
    });

    decisions.push({
      action: llmDecision.action,
      candidate: ec,
      existing_memory_id: llmDecision.existing_memory_id ?? undefined,
      merged_content: llmDecision.merged_content ?? undefined,
      reason: llmDecision.reason,
    });
  }

  return decisions;
}
