import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import { PurgeRequest, PurgeAllRequest, PurgeMessage, PurgeJobStatus } from '@deeprecall/types';
import type { AppBindings } from '../types';

/**
 * Purge job status is persisted in KV with a 24h TTL. Callers poll the
 * status endpoint with the job_id returned from the POST to track progress.
 */
const JOB_TTL_SECONDS = 60 * 60 * 24;

function jobKvKey(productId: string, jobId: string): string {
  return `purge_job:${productId}:${jobId}`;
}

// ─── Scoped purge router — mounted at /v1/memories/purge ────

export const purgeScoped = new Hono<AppBindings>();

/**
 * POST /v1/memories/purge
 * Scoped purge — deletes every memory matching the given user/agent scope
 * within the caller's product.
 *
 * Async: returns 202 with a job_id. Poll GET /v1/memories/purge/status/:job_id.
 * Dry-run (dry_run=true) is synchronous and returns an estimated count.
 */
purgeScoped.post('/', async (c) => {
  const productId = c.get('product_id');

  const body = await c.req.json();
  const parsed = PurgeRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid purge request', parsed.error.flatten());
  }

  const { scope, confirm, dry_run } = parsed.data;

  if (dry_run) {
    // listByScope uses relaxed matching (null fields on memories pass), so
    // we fetch a large batch and count strict matches manually to reflect
    // what memoryDeleteByScope (strict) would actually delete.
    const preview = await c.env.DATA.memoryListByScope(
      productId,
      { user_id: scope.user_id, agent_id: scope.agent_id },
      { limit: 10000 },
    );
    const strictMatches = preview.items.filter((m) => {
      if (scope.user_id !== undefined && m.user_id !== scope.user_id) return false;
      if (scope.agent_id !== undefined && m.agent_id !== scope.agent_id) return false;
      return true;
    });
    return c.json({
      dry_run: true as const,
      type: 'purge_scoped' as const,
      scope,
      memories_would_delete: strictMatches.length,
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

  const jobId = `purge_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const initialStatus: PurgeJobStatus = {
    job_id: jobId,
    product_id: productId,
    type: 'purge_scoped',
    status: 'pending',
    scope,
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
    type: 'purge_scoped',
    job_id: jobId,
    product_id: productId,
    scope,
    created_at: now,
  };
  await c.env.CONSOLIDATION_QUEUE.send(message);

  return c.json(
    {
      job_id: jobId,
      status: 'pending' as const,
      type: 'purge_scoped' as const,
      status_url: `/v1/memories/purge/status/${jobId}`,
    },
    202,
  );
});

/**
 * GET /v1/memories/purge/status/:job_id
 * Return the current status of a purge job. Jobs expire from KV after 24h.
 */
purgeScoped.get('/status/:job_id', async (c) => {
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

  // Defense in depth — the KV key already includes product_id, but re-check
  // the body so a cross-tenant key collision (impossible today) can't leak.
  if (parsed.data.product_id !== productId) {
    return apiError(c, 404, 'NOT_FOUND', `Purge job ${jobId} not found`);
  }

  return c.json(parsed.data);
});

// ─── Product-wide purge router — mounted at /v1/memories/purge-all ──

export const purgeAll = new Hono<AppBindings>();

/**
 * POST /v1/memories/purge-all
 * Nuclear purge — deletes every memory the calling product owns.
 *
 * Requires confirm_product_id to equal the API-key-derived product_id so
 * a misconfigured client can't accidentally nuke the wrong tenant.
 */
purgeAll.post('/', async (c) => {
  const productId = c.get('product_id');

  const body = await c.req.json();
  const parsed = PurgeAllRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Invalid purge-all request',
      parsed.error.flatten(),
    );
  }

  const { confirm_product_id, confirm, dry_run, include_documents } = parsed.data;

  if (confirm_product_id !== productId) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'confirm_product_id does not match the authenticated product',
    );
  }

  if (dry_run) {
    // Product-wide preview: iterate every known user_id and agent_id to
    // union all memory IDs. Bounded to 10k of each to cap this endpoint.
    // For an exact total, run the job and read the status response.
    const userIds = await c.env.DATA.memoryGetActiveUserIds(productId, 10000);
    const agentIds = await c.env.DATA.memoryGetActiveAgentIds(productId, 10000);
    const seen = new Set<string>();
    for (const userId of userIds) {
      const result = await c.env.DATA.memoryListByScope(
        productId,
        { user_id: userId },
        { limit: 10000 },
      );
      for (const m of result.items) seen.add(m.id);
    }
    for (const agentId of agentIds) {
      const result = await c.env.DATA.memoryListByScope(
        productId,
        { agent_id: agentId },
        { limit: 10000 },
      );
      for (const m of result.items) seen.add(m.id);
    }
    return c.json({
      dry_run: true as const,
      type: 'purge_product' as const,
      scope: null,
      memories_would_delete: seen.size,
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

  const jobId = `purge_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const initialStatus: PurgeJobStatus = {
    job_id: jobId,
    product_id: productId,
    type: 'purge_product',
    status: 'pending',
    scope: null,
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
    type: 'purge_product',
    job_id: jobId,
    product_id: productId,
    include_documents,
    created_at: now,
  };
  await c.env.CONSOLIDATION_QUEUE.send(message);

  return c.json(
    {
      job_id: jobId,
      status: 'pending' as const,
      type: 'purge_product' as const,
      include_documents,
      status_url: `/v1/memories/purge/status/${jobId}`,
    },
    202,
  );
});
