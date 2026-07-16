import type { DataService } from '@deeprecall/worker-data';
import { DocumentRequestError } from './errors';

// Batch sizes mirror the purge worker — kept conservative so a single delete
// call stays well under Vectorize/D1 parameter limits.
const VECTOR_DELETE_BATCH = 1000;
const AUDIT_DELETE_BATCH = 500;

/**
 * Sync cascades cap out here; anything larger must go through the async
 * purge path. One doc typically yields tens of memories, so this is a
 * safety valve, not a working limit.
 */
export const MAX_CASCADE_MEMORIES = 5000;

/** Counts returned by the cascade so callers can verify what was removed. */
export interface CascadeCounts {
  memoriesDeleted: number;
  vectorsDeleted: number;
  auditsDeleted: number;
}

/**
 * List the memory IDs linked to a document, rejecting oversize cascades
 * synchronously. `tooLargeMessage` differs per endpoint (replace vs delete
 * point callers at different recovery paths).
 */
export async function listCascadeMemoryIds(
  data: Service<DataService>,
  productId: string,
  documentId: string,
  tooLargeMessage: string,
): Promise<string[]> {
  const memoryIds = await data.memoryListIdsByDocumentId(
    productId,
    documentId,
    MAX_CASCADE_MEMORIES + 1,
  );
  if (memoryIds.length > MAX_CASCADE_MEMORIES) {
    throw new DocumentRequestError(tooLargeMessage, 409, 'CASCADE_TOO_LARGE');
  }
  return memoryIds;
}

/** Delete vectors then audits for a batch of memory IDs, accumulating counts. */
async function deleteVectorsAndAudits(
  data: Service<DataService>,
  productId: string,
  memoryIds: string[],
  counts: CascadeCounts,
): Promise<void> {
  for (let i = 0; i < memoryIds.length; i += VECTOR_DELETE_BATCH) {
    const chunk = memoryIds.slice(i, i + VECTOR_DELETE_BATCH);
    await data.vectorDeleteMany(productId, chunk);
    counts.vectorsDeleted += chunk.length;
  }
  for (let i = 0; i < memoryIds.length; i += AUDIT_DELETE_BATCH) {
    const chunk = memoryIds.slice(i, i + AUDIT_DELETE_BATCH);
    counts.auditsDeleted += await data.auditDeleteByMemoryIds(productId, chunk);
  }
}

/**
 * Cascade-delete every memory extracted from a document: vectors → audits →
 * memory rows, in the same order as the purge worker so a mid-flight crash
 * followed by a retry converges on the same end state (each step is
 * idempotent).
 *
 * Includes a second-pass listing to catch memories a concurrent ingestion
 * wrote for this document_id between the caller's initial listing and the
 * SQL delete — those would otherwise leave ghost vectors.
 *
 * `firstPassIds` must come from listCascadeMemoryIds so the oversize check
 * has already run.
 */
export async function cascadeDeleteDocumentMemories(
  data: Service<DataService>,
  productId: string,
  documentId: string,
  firstPassIds: string[],
): Promise<CascadeCounts> {
  const counts: CascadeCounts = { memoriesDeleted: 0, vectorsDeleted: 0, auditsDeleted: 0 };

  if (firstPassIds.length > 0) {
    await deleteVectorsAndAudits(data, productId, firstPassIds, counts);
  }
  counts.memoriesDeleted = await data.memoryDeleteByDocumentId(productId, documentId);

  // Safety net — any memory rows created between the initial listing and
  // the SQL delete were just wiped by the DELETE, but their vectors and
  // audits weren't cleaned. Catch them here.
  const leftoverIds = await data.memoryListIdsByDocumentId(
    productId,
    documentId,
    MAX_CASCADE_MEMORIES + 1,
  );
  if (leftoverIds.length > 0) {
    await deleteVectorsAndAudits(data, productId, leftoverIds, counts);
    counts.memoriesDeleted += await data.memoryDeleteByDocumentId(productId, documentId);
  }

  return counts;
}
