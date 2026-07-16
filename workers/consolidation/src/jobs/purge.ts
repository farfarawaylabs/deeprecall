import type { DataService } from '@deeprecall/worker-data';
import type { PurgeMessage, PurgeJobStatus, PurgeScope } from '@deeprecall/types';

/**
 * Chunk size for vector-delete RPC calls to the data worker. The Vectorize
 * `deleteByIds` 100-id hard limit is enforced inside VectorizeService, so
 * this only bounds the per-RPC payload.
 */
const VECTOR_DELETE_BATCH = 1000;

/**
 * Chunk size for audit-delete RPC calls to the data worker. The D1 100-bound-
 * param limit is enforced inside the audit repository, so this only bounds
 * the per-RPC payload.
 */
const AUDIT_DELETE_BATCH = 500;

/**
 * Upper bound on IDs collected in a single job invocation. At ~40 bytes per
 * ID-string this is ~4MB in memory, well under Workers limits. Products
 * above this threshold would need a paginated purge — revisit if we hit it.
 */
const MAX_IDS_PER_JOB = 100_000;

/**
 * Cap on documents returned per `list*CleanupRefs` call. Same MAX_IDS_PER_JOB
 * reasoning — one D1 row per doc, well under memory limits.
 */
const MAX_DOCS_PER_JOB = 100_000;

export interface PurgeJobResult {
  memories_deleted: number;
  vectors_deleted: number;
  audits_deleted: number;
  documents_deleted: number;
  r2_blobs_deleted: number;
}

function jobKvKey(productId: string, jobId: string): string {
  return `purge_job:${productId}:${jobId}`;
}

/**
 * Read-modify-write a purge job's KV status record. If the key is missing
 * or malformed, skips the update — the caller still has the in-memory copy
 * and we'd rather lose one progress update than crash the purge.
 */
async function updateJobStatus(
  kv: KVNamespace,
  productId: string,
  jobId: string,
  update: (current: PurgeJobStatus) => PurgeJobStatus,
  ttlSeconds: number,
): Promise<void> {
  const raw = await kv.get(jobKvKey(productId, jobId));
  if (!raw) return;
  try {
    const current = JSON.parse(raw) as PurgeJobStatus;
    const next = update(current);
    await kv.put(jobKvKey(productId, jobId), JSON.stringify(next), {
      expirationTtl: ttlSeconds,
    });
  } catch {
    // Malformed payload — skip rather than overwrite with guessed state.
  }
}

/**
 * Batched vector + audit cleanup for a set of memory IDs. Runs vectors
 * first, then audits — order doesn't matter for correctness (each is
 * idempotent) but this mirrors the sequencing in runPurge. Memories
 * themselves are not deleted here; caller handles that.
 */
async function cascadeMemoryCleanup(
  productId: string,
  memoryIds: string[],
  data: Service<DataService>,
): Promise<{ vectors_deleted: number; audits_deleted: number }> {
  if (memoryIds.length === 0) {
    return { vectors_deleted: 0, audits_deleted: 0 };
  }
  let vectors_deleted = 0;
  let audits_deleted = 0;

  for (let i = 0; i < memoryIds.length; i += VECTOR_DELETE_BATCH) {
    const chunk = memoryIds.slice(i, i + VECTOR_DELETE_BATCH);
    await data.vectorDeleteMany(productId, chunk);
    vectors_deleted += chunk.length;
  }

  for (let i = 0; i < memoryIds.length; i += AUDIT_DELETE_BATCH) {
    const chunk = memoryIds.slice(i, i + AUDIT_DELETE_BATCH);
    audits_deleted += await data.auditDeleteByMemoryIds(productId, chunk);
  }

  return { vectors_deleted, audits_deleted };
}

/**
 * Execute a purge job. Deletes vectors first, then audits, then memories —
 * this order makes the operation idempotent under queue retries: if we
 * fail before the final D1 delete, the next retry finds the same IDs and
 * repeats vector/audit deletes (Vectorize and SQL `IN` are no-ops for
 * already-missing targets).
 *
 * `purge_product` also wipes documents + R2 objects at the end so the
 * product reaches a true clean slate in a single job.
 */
export async function runPurge(
  msg: PurgeMessage,
  data: Service<DataService>,
  kv: KVNamespace,
): Promise<PurgeJobResult> {
  const { job_id, product_id, type, scope } = msg;
  const jobTtl = 60 * 60 * 24; // 24h, matches memory-api

  const startedAt = new Date().toISOString();
  await updateJobStatus(
    kv,
    product_id,
    job_id,
    (s) => ({ ...s, status: 'processing', started_at: startedAt }),
    jobTtl,
  );

  let result: PurgeJobResult;

  if (type === 'purge_scoped') {
    if (!scope) {
      throw new Error(`purge_scoped message ${job_id} is missing scope`);
    }
    result = await runMemoryPurgeScoped(product_id, scope, data);
  } else if (type === 'purge_product') {
    result = await runMemoryPurgeAll(product_id, data);
    if (msg.include_documents === true) {
      // Opt-in cascade: caller explicitly asked for docs + R2 to go too.
      // Memories were already removed above so the docs helper runs with
      // memoriesAlreadyWiped=true — it only touches D1 documents table
      // and R2 prefix. We merge counts so the status shows the full
      // blast radius.
      const docsResult = await runDocumentsPurge(product_id, undefined, data, {
        memoriesAlreadyWiped: true,
      });
      result = {
        memories_deleted: result.memories_deleted,
        vectors_deleted: result.vectors_deleted,
        audits_deleted: result.audits_deleted,
        documents_deleted: docsResult.documents_deleted,
        r2_blobs_deleted: docsResult.r2_blobs_deleted,
      };
    }
  } else if (type === 'purge_documents_scoped') {
    if (!scope) {
      throw new Error(`purge_documents_scoped message ${job_id} is missing scope`);
    }
    result = await runDocumentsPurge(product_id, scope, data);
  } else if (type === 'purge_documents_all') {
    result = await runDocumentsPurge(product_id, undefined, data);
  } else {
    throw new Error(`Unknown purge type: ${type as string}`);
  }

  const completedAt = new Date().toISOString();
  await updateJobStatus(
    kv,
    product_id,
    job_id,
    (s) => ({
      ...s,
      status: 'completed',
      memories_deleted: result.memories_deleted,
      vectors_deleted: result.vectors_deleted,
      audits_deleted: result.audits_deleted,
      documents_deleted: result.documents_deleted,
      r2_blobs_deleted: result.r2_blobs_deleted,
      completed_at: completedAt,
    }),
    jobTtl,
  );

  return result;
}

/**
 * Scoped memory purge — strict scope match. Vectors + audits first (for
 * idempotency), then the DELETE on memories.
 */
async function runMemoryPurgeScoped(
  productId: string,
  scope: PurgeScope,
  data: Service<DataService>,
): Promise<PurgeJobResult> {
  const memoryIds = await data.memoryListIdsByScopeStrict(
    productId,
    { user_id: scope.user_id, agent_id: scope.agent_id },
    MAX_IDS_PER_JOB,
  );
  const cleanup = await cascadeMemoryCleanup(productId, memoryIds, data);
  const memoriesDeleted = await data.memoryDeleteByScope(productId, {
    user_id: scope.user_id,
    agent_id: scope.agent_id,
  });

  return {
    memories_deleted: memoriesDeleted,
    vectors_deleted: cleanup.vectors_deleted,
    audits_deleted: cleanup.audits_deleted,
    documents_deleted: 0,
    r2_blobs_deleted: 0,
  };
}

/**
 * Product-wide memory purge. Leaves documents + R2 blobs to the caller
 * (see runPurge → purge_product branch, which also calls runDocumentsPurge).
 */
async function runMemoryPurgeAll(
  productId: string,
  data: Service<DataService>,
): Promise<PurgeJobResult> {
  const memoryIds = await data.memoryListAllIds(productId, MAX_IDS_PER_JOB);
  const cleanup = await cascadeMemoryCleanup(productId, memoryIds, data);
  const memoriesDeleted = await data.memoryDeleteAll(productId);

  return {
    memories_deleted: memoriesDeleted,
    vectors_deleted: cleanup.vectors_deleted,
    audits_deleted: cleanup.audits_deleted,
    documents_deleted: 0,
    r2_blobs_deleted: 0,
  };
}

/**
 * Purge documents — either scoped (by uploader) or product-wide.
 *
 * Scoped flow:
 *   1. List cleanup refs (id + r2_key) for rows matching the scope (strict)
 *   2. Collect memory IDs for each doc, cascade vectors + audits
 *   3. Delete memories with document_id matching any of those docs
 *   4. Delete R2 blobs for those keys
 *   5. Delete document rows matching that scope
 *
 * Product-wide flow:
 *   1. Collect all memory IDs with document_id set
 *   2. Cascade vectors + audits
 *   3. Delete every memory tied to any document
 *   4. Delete every R2 blob under `{productId}/documents/`
 *   5. Delete every document row
 *
 * `memoriesAlreadyWiped: true` skips the memory cascade — used when the
 * caller (e.g. purge_product) just ran `memoryDeleteAll`, so the doc-
 * linked memories are already gone.
 */
export async function runDocumentsPurge(
  productId: string,
  scope: PurgeScope | undefined,
  data: Service<DataService>,
  opts: { memoriesAlreadyWiped?: boolean } = {},
): Promise<PurgeJobResult> {
  const skipMemoryCascade = opts.memoriesAlreadyWiped === true;

  let vectorsDeleted = 0;
  let auditsDeleted = 0;
  let memoriesDeleted = 0;
  let r2BlobsDeleted = 0;
  let documentsDeleted = 0;

  if (scope) {
    // ── Scoped ──────────────────────────────────────────────
    // Strict scope match — a scoped purge refuses to sweep up rows where
    // the target dimension is null on the row (symmetric with memory purge).
    const scopeKeys = { user_id: scope.user_id, agent_id: scope.agent_id };
    const refs = await data.documentRecordListCleanupRefsByScope(
      productId,
      scopeKeys,
      MAX_DOCS_PER_JOB,
    );

    if (refs.length === 0) {
      return {
        memories_deleted: 0,
        vectors_deleted: 0,
        audits_deleted: 0,
        documents_deleted: 0,
        r2_blobs_deleted: 0,
      };
    }

    if (!skipMemoryCascade) {
      const memoryIds: string[] = [];
      for (const ref of refs) {
        const ids = await data.memoryListIdsByDocumentId(productId, ref.id, MAX_IDS_PER_JOB);
        memoryIds.push(...ids);
        if (memoryIds.length >= MAX_IDS_PER_JOB) break;
      }
      const cleanup = await cascadeMemoryCleanup(productId, memoryIds, data);
      vectorsDeleted = cleanup.vectors_deleted;
      auditsDeleted = cleanup.audits_deleted;

      // One SQL DELETE per doc. Fine for typical per-uploader doc counts;
      // we can switch to a batched `IN (...)` delete if a product exceeds
      // the threshold where this becomes slow.
      for (const ref of refs) {
        memoriesDeleted += await data.memoryDeleteByDocumentId(productId, ref.id);
      }

      // Safety net — catch memories a concurrent ingestion wrote for any
      // of these document_ids between our listing and the DELETE. Their
      // D1 rows are already gone; clean up their vectors and audits.
      const leftover: string[] = [];
      for (const ref of refs) {
        const ids = await data.memoryListIdsByDocumentId(productId, ref.id, MAX_IDS_PER_JOB);
        leftover.push(...ids);
        if (leftover.length >= MAX_IDS_PER_JOB) break;
      }
      if (leftover.length > 0) {
        const secondPass = await cascadeMemoryCleanup(productId, leftover, data);
        vectorsDeleted += secondPass.vectors_deleted;
        auditsDeleted += secondPass.audits_deleted;
        for (const ref of refs) {
          memoriesDeleted += await data.memoryDeleteByDocumentId(productId, ref.id);
        }
      }
    }

    // R2 blobs — delete the exact key list we collected.
    r2BlobsDeleted = await data.documentDeleteMany(refs.map((r) => r.r2_key));

    // Document rows for this scope.
    documentsDeleted = await data.documentRecordDeleteByScope(productId, scopeKeys);
  } else {
    // ── Product-wide ────────────────────────────────────────
    if (!skipMemoryCascade) {
      const memoryIds = await data.memoryListIdsWithAnyDocument(productId, MAX_IDS_PER_JOB);
      const cleanup = await cascadeMemoryCleanup(productId, memoryIds, data);
      vectorsDeleted = cleanup.vectors_deleted;
      auditsDeleted = cleanup.audits_deleted;

      // Single SQL: delete every memory tied to any document.
      memoriesDeleted = await data.memoryDeleteAllWithDocument(productId);

      // Safety net — concurrent ingestion could have committed more
      // memory rows between our listing and the DELETE above. Their D1
      // rows are already gone; re-check and clean up any leftover
      // vectors/audits.
      const leftoverIds = await data.memoryListIdsWithAnyDocument(productId, MAX_IDS_PER_JOB);
      if (leftoverIds.length > 0) {
        const secondPass = await cascadeMemoryCleanup(productId, leftoverIds, data);
        vectorsDeleted += secondPass.vectors_deleted;
        auditsDeleted += secondPass.audits_deleted;
        memoriesDeleted += await data.memoryDeleteAllWithDocument(productId);
      }
    }

    // R2: wipe the entire product's documents prefix in one sweep.
    r2BlobsDeleted = await data.documentDeleteByPrefix(`${productId}/documents/`);

    // D1: wipe every document row.
    documentsDeleted = await data.documentRecordDeleteAll(productId);
  }

  return {
    memories_deleted: memoriesDeleted,
    vectors_deleted: vectorsDeleted,
    audits_deleted: auditsDeleted,
    documents_deleted: documentsDeleted,
    r2_blobs_deleted: r2BlobsDeleted,
  };
}

/**
 * Mark a job as failed. Called on the final retry exhaustion so callers
 * polling the status endpoint see a terminal state.
 */
export async function markPurgeFailed(
  kv: KVNamespace,
  productId: string,
  jobId: string,
  error: string,
): Promise<void> {
  await updateJobStatus(
    kv,
    productId,
    jobId,
    (s) => ({
      ...s,
      status: 'failed',
      error,
      completed_at: new Date().toISOString(),
    }),
    60 * 60 * 24,
  );
}
