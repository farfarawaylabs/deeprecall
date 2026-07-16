import type { DataService } from '@deeprecall/worker-data';

/** Default: decay memories not updated in 30 days. */
const DEFAULT_STALE_DAYS = 30;
/** Default: multiply confidence by 0.9 each decay cycle. */
const DEFAULT_DECAY_FACTOR = 0.9;
/** Minimum confidence before archiving. */
const MIN_CONFIDENCE = 0.1;
const BATCH_SIZE = 200;

export interface ConfidenceDecayConfig {
  staleDays?: number;
  decayFactor?: number;
}

export interface ConfidenceDecayResult {
  decayed_count: number;
  archived_count: number;
}

/**
 * Confidence Decay Job:
 * Reduce confidence of memories that haven't been reinforced recently.
 * Memories from user_stated source are exempt (handled by the query).
 * Memories below MIN_CONFIDENCE are archived.
 */
export async function runConfidenceDecay(
  data: Service<DataService>,
  productId: string,
  config?: ConfidenceDecayConfig,
): Promise<ConfidenceDecayResult> {
  const staleDays = config?.staleDays ?? DEFAULT_STALE_DAYS;
  const decayFactor = config?.decayFactor ?? DEFAULT_DECAY_FACTOR;

  const cutoffDate = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const staleMemories = await data.memoryFindStaleMemories(productId, cutoffDate, BATCH_SIZE);

  let decayedCount = 0;
  let archivedCount = 0;

  for (const memory of staleMemories) {
    const newConfidence = Math.round(memory.confidence * decayFactor * 1000) / 1000;

    if (newConfidence < MIN_CONFIDENCE) {
      await data.memoryUpdateStatus(productId, memory.id, 'archived');
      await data.vectorDelete(productId, memory.id);
      await data.auditLog(
        productId,
        'confidence_updated',
        memory.id,
        `Confidence decayed below threshold (${newConfidence.toFixed(3)} < ${MIN_CONFIDENCE}), archived`,
        { confidence: memory.confidence },
        { confidence: newConfidence, status: 'archived' },
        'consolidation',
      );
      archivedCount++;
    } else {
      await data.memoryUpdateConfidence(productId, memory.id, newConfidence);
      await data.auditLog(
        productId,
        'confidence_updated',
        memory.id,
        `Confidence decayed: ${memory.confidence.toFixed(3)} -> ${newConfidence.toFixed(3)} (factor: ${decayFactor}, stale > ${staleDays}d)`,
        { confidence: memory.confidence },
        { confidence: newConfidence },
        'consolidation',
      );
      decayedCount++;
    }
  }

  return {
    decayed_count: decayedCount,
    archived_count: archivedCount,
  };
}
