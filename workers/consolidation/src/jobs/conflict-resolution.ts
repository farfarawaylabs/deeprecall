import type { DataService } from '@deeprecall/worker-data';
import type { Memory } from '@deeprecall/types';
import type { MemoryCreateInput, ScopeKeys } from '@deeprecall/db';
import { type ClaudeConfig, adjudicateConflict } from '@deeprecall/ai';
import { buildVectorizeFilters } from '@deeprecall/vectorize';

const SIMILARITY_THRESHOLD = 0.85;
const BATCH_SIZE = 20;
/** Max similar memories adjudicated per new memory (cost bound). */
const MAX_CONFLICTS_PER_MEMORY = 3;

export interface ConflictResolutionResult {
  conflicts_found: number;
  resolved_count: number;
}

/**
 * Conflict Resolution Job:
 * For newly ingested memories, find highly similar active memories in the
 * same scope and let an LLM adjudicate each pair. Similarity alone is never
 * treated as contradiction — the LLM decides whether the pair is distinct
 * (keep both), duplicate (retire the redundant one), or contradictory
 * (merge into one complete record). Information is never destroyed: a
 * supersede is only taken when the survivor fully covers the retired
 * memory, and merges preserve every concrete detail from both sides.
 */
export async function runConflictResolution(
  scope: ScopeKeys,
  memoryIds: string[],
  data: Service<DataService>,
  productId: string,
  claude: ClaudeConfig,
): Promise<ConflictResolutionResult> {
  if (!scope.user_id && !scope.agent_id) {
    throw new Error(
      'runConflictResolution: scope must include at least one of user_id or agent_id',
    );
  }

  let conflictsFound = 0;
  let resolvedCount = 0;

  // Get the newly created memories
  const newMemories = await data.memoryGetByIds(productId, memoryIds);
  const activeNewMemories = newMemories.filter((m) => m.status === 'active');

  // Pre-compute Vectorize filter variants for this scope. Vectorize can't
  // OR across keys, so scopes carrying both user_id and agent_id require
  // two fan-out queries unioned by id.
  const filterVariants = buildVectorizeFilters(scope, { status: 'active' });

  for (const memory of activeNewMemories.slice(0, BATCH_SIZE)) {
    // A memory may have been retired by an earlier pair in this same run
    const current = await data.memoryGetByIds(productId, [memory.id]);
    if (current[0]?.status !== 'active') continue;

    // Generate embedding for similarity search
    const embeddings = await data.generateEmbeddings([memory.content]);
    const embedding = embeddings[0];
    if (!embedding) continue;

    // Search for similar memories in the same scope (fan out).
    const batches = await Promise.all(
      filterVariants.map((filter) => data.vectorSearch(productId, embedding, filter, 10)),
    );
    const bestById = new Map<string, { memory_id: string; score: number }>();
    for (const batch of batches) {
      for (const row of batch) {
        const prev = bestById.get(row.memory_id);
        if (!prev || row.score > prev.score) bestById.set(row.memory_id, row);
      }
    }
    const similar = Array.from(bestById.values()).sort((a, b) => b.score - a.score);

    // Filter to high-similarity matches that aren't the same memory
    const potentialConflicts = similar
      .filter((s) => s.memory_id !== memory.id && s.score >= SIMILARITY_THRESHOLD)
      .slice(0, MAX_CONFLICTS_PER_MEMORY);

    if (potentialConflicts.length === 0) continue;

    // Fetch the conflicting memories
    const conflictIds = potentialConflicts.map((c) => c.memory_id);
    const conflictingMemories = await data.memoryGetByIds(productId, conflictIds);
    const activeConflicts = conflictingMemories.filter((m) => m.status === 'active');

    for (const conflict of activeConflicts) {
      // Skip if the conflict is one of the newly ingested memories (handled by reconciliation)
      if (memoryIds.includes(conflict.id)) continue;
      // Skip pinned memories (user_stated with confidence 1.0)
      if (conflict.source_type === 'user_stated' && conflict.confidence >= 1.0) {
        continue;
      }

      conflictsFound++;

      let adjudication;
      try {
        adjudication = await adjudicateConflict(memory, conflict, {
          claude,
        });
      } catch {
        // Adjudication is best-effort maintenance — a failed call must not
        // kill the job or fall back to destructive rules. Leave both active.
        continue;
      }

      if (adjudication.action === 'keep_both') continue;

      if (adjudication.action === 'merge' && adjudication.merged_content) {
        await mergePair(
          memory,
          conflict,
          adjudication.merged_content,
          adjudication.reason,
          data,
          productId,
        );
        resolvedCount++;
        continue;
      }

      if (adjudication.action === 'supersede_a' || adjudication.action === 'supersede_b') {
        const loser = adjudication.action === 'supersede_a' ? memory : conflict;
        const winner = adjudication.action === 'supersede_a' ? conflict : memory;

        await data.memoryUpdateStatus(productId, loser.id, 'superseded', winner.id);
        await data.vectorDelete(productId, loser.id);
        await data.auditLog(
          productId,
          'superseded',
          loser.id,
          `LLM-adjudicated ${adjudication.relation} with ${winner.id}: ${adjudication.reason}`,
          loser,
          null,
          'consolidation',
        );
        resolvedCount++;
      }
    }
  }

  return {
    conflicts_found: conflictsFound,
    resolved_count: resolvedCount,
  };
}

/**
 * Replace both memories of a pair with a single merged record that carries
 * every concrete detail. The merged memory inherits provenance from the
 * newer side and unions tags; both originals are superseded by it.
 */
async function mergePair(
  newer: Memory,
  older: Memory,
  mergedContent: string,
  reason: string,
  data: Service<DataService>,
  productId: string,
): Promise<void> {
  const mergedId = crypto.randomUUID();
  const now = new Date().toISOString();

  const tags = Array.from(new Set([...(newer.tags ?? []), ...(older.tags ?? [])]));

  const validityStarts = [newer.validity_start, older.validity_start].filter(
    (v): v is string => v !== null,
  );
  const validityEnds = [newer.validity_end, older.validity_end].filter(
    (v): v is string => v !== null,
  );

  const mergedInput: MemoryCreateInput = {
    id: mergedId,
    content: mergedContent,
    episode: newer.episode ?? older.episode,
    type: newer.type,
    status: 'active',
    user_id: newer.user_id,
    agent_id: newer.agent_id,
    session_id: newer.session_id,
    source_actor: newer.source_actor,
    source_type: newer.source_type,
    source_channel: newer.source_channel,
    confidence: Math.max(newer.confidence, older.confidence),
    document_id: newer.document_id,
    validity_start: validityStarts.length > 0 ? validityStarts.sort()[0] : null,
    validity_end: validityEnds.length > 0 ? (validityEnds.sort().at(-1) ?? null) : null,
    observed_at: now,
    tags,
    subject: newer.subject ?? older.subject,
    predicate: newer.predicate ?? older.predicate,
    object: newer.object ?? older.object,
  };

  const mergedMemory = await data.memoryCreate(productId, mergedInput);

  const embeddings = await data.generateEmbeddings([mergedContent]);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error('Failed to generate embedding for merged memory');
  }

  const vectorMetadata: {
    user_id?: string;
    agent_id?: string;
    type: string;
    status: string;
    source_type: string;
    confidence: number;
  } = {
    type: mergedInput.type,
    status: 'active',
    source_type: mergedInput.source_type,
    confidence: mergedInput.confidence,
  };
  if (mergedInput.user_id) vectorMetadata.user_id = mergedInput.user_id;
  if (mergedInput.agent_id) vectorMetadata.agent_id = mergedInput.agent_id;
  await data.vectorUpsert(productId, mergedId, embedding, vectorMetadata);

  for (const original of [newer, older]) {
    await data.memoryUpdateStatus(productId, original.id, 'superseded', mergedId);
    await data.vectorDelete(productId, original.id);
    await data.auditLog(
      productId,
      'superseded',
      original.id,
      `Merged into ${mergedId} (LLM-adjudicated): ${reason}`,
      original,
      null,
      'consolidation',
    );
  }

  await data.auditLog(
    productId,
    'created',
    mergedId,
    `Merged from ${newer.id} + ${older.id} (LLM-adjudicated): ${reason}`,
    null,
    mergedMemory,
    'consolidation',
  );
}
