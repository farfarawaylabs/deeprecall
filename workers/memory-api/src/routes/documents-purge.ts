import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DocumentPurgeRequest,
  PurgeJobStatus,
  type PurgeMessage,
  type PurgeJobStatus as PurgeJobStatusT,
  type PurgeScope,
} from '@deeprecall/types';
import type { AppBindings } from '../types';

/**
 * Document purge routes mirror `/v1/memories/purge` + `/v1/memories/purge-all`
 * — same async pattern, same KV-backed job status, same confirm/dry-run UX.
 *
 * Kept separate from routes/documents.ts so the upload/download/list code
 * and the destructive async flows are easy to audit independently.
 */

const JOB_TTL_SECONDS = 60 * 60 * 24;

function jobKvKey(productId: string, jobId: string): string {
  return `purge_job:${productId}:${jobId}`;
}

// ─── Scoped documents purge — mounted at /v1/documents/purge ──

export const documentsPurge = new Hono<AppBindings>();

/**
 * Dry-run preview for the scoped variant. Counts by reading cleanup refs
 * matching the strict scope and summing memory IDs per doc. Does not
 * schedule a job or write to KV.
 */
async function previewScoped(
  c: Context<AppBindings>,
  productId: string,
  scope: PurgeScope,
): Promise<{ documents: number; memories: number }> {
  const refs = await c.env.DATA.documentRecordListCleanupRefsByScope(
    productId,
    { user_id: scope.user_id, agent_id: scope.agent_id },
    100_000,
  );
  let memories = 0;
  for (const ref of refs) {
    const ids = await c.env.DATA.memoryListIdsByDocumentId(productId, ref.id, 100_000);
    memories += ids.length;
  }
  return { documents: refs.length, memories };
}

/**
 * POST /v1/documents/purge
 * Async purge of documents matching a scope. Accepts either:
 *   - `{ scope: { user_id? agent_id? } }` for a scoped purge, or
 *   - `{ confirm_product_id }` for a product-wide purge.
 * Exactly one must be provided (see DocumentPurgeRequest refinement).
 */
documentsPurge.post('/', async (c) => {
  const productId = c.get('product_id');

  const body = await c.req.json();
  const parsed = DocumentPurgeRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Invalid documents purge request',
      parsed.error.flatten(),
    );
  }

  const { scope, confirm_product_id, confirm, dry_run } = parsed.data;
  const isScoped = !!scope;
  const type: PurgeMessage['type'] = isScoped ? 'purge_documents_scoped' : 'purge_documents_all';

  // Product-wide must match the authenticated product.
  if (!isScoped && confirm_product_id !== productId) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'confirm_product_id does not match the authenticated product',
    );
  }

  if (dry_run) {
    if (isScoped) {
      const preview = await previewScoped(c, productId, scope!);
      return c.json({
        dry_run: true as const,
        scope: scope!,
        documents_would_delete: preview.documents,
        memories_would_delete: preview.memories,
      });
    }
    // Product-wide: list all cleanup refs + all memory-with-doc IDs.
    const refs = await c.env.DATA.documentRecordListAllCleanupRefs(productId, 100_000);
    const memoryIds = await c.env.DATA.memoryListIdsWithAnyDocument(productId, 100_000);
    return c.json({
      dry_run: true as const,
      scope: null,
      documents_would_delete: refs.length,
      memories_would_delete: memoryIds.length,
    });
  }

  if (!confirm) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Missing confirmation: set confirm=true to execute the purge',
    );
  }

  // Schedule the job.
  const jobId = `purge_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const initialStatus: PurgeJobStatusT = {
    job_id: jobId,
    product_id: productId,
    type,
    status: 'pending',
    scope: isScoped ? scope! : null,
    memories_deleted: 0,
    vectors_deleted: 0,
    audits_deleted: 0,
    documents_deleted: 0,
    r2_blobs_deleted: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    error: null,
  };
  await c.env.CONFIG.put(jobKvKey(productId, jobId), JSON.stringify(initialStatus), {
    expirationTtl: JOB_TTL_SECONDS,
  });

  const message: PurgeMessage = {
    kind: 'purge',
    type,
    job_id: jobId,
    product_id: productId,
    scope: isScoped ? scope! : undefined,
    created_at: now,
  };
  await c.env.CONSOLIDATION_QUEUE.send(message);

  return c.json(
    {
      job_id: jobId,
      status: 'pending' as const,
      type,
      status_url: `/v1/documents/purge/status/${jobId}`,
    },
    202,
  );
});

/**
 * GET /v1/documents/purge/status/:job_id
 * Reads the same KV-backed purge job record as /v1/memories/purge/status —
 * documents purge jobs use the same `purge_job:{product_id}:{job_id}` key.
 */
documentsPurge.get('/status/:job_id', async (c) => {
  const productId = c.get('product_id');
  const jobId = c.req.param('job_id');

  const raw = await c.env.CONFIG.get(jobKvKey(productId, jobId));
  if (!raw) {
    return apiError(c, 404, 'NOT_FOUND', `Purge job ${jobId} not found (jobs expire after 24h)`);
  }

  const parsed = PurgeJobStatus.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return apiError(c, 500, 'INTERNAL_ERROR', 'Stored job status is malformed');
  }

  if (parsed.data.product_id !== productId) {
    return apiError(c, 404, 'NOT_FOUND', `Purge job ${jobId} not found`);
  }

  return c.json(parsed.data);
});
