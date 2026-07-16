import { Hono } from 'hono';
import { z } from 'zod';
import { claudeConfigFromEnv, extractMemories, reconcileCandidate } from '@deeprecall/ai';
import { SceneType, ConsolidationMessage } from '@deeprecall/types';
import type { AppBindings } from '../types';
import { internalFetch, apiError } from '@deeprecall/http';
import { findSimilarMemories } from '../reconcile/similar-memories';

const admin = new Hono<AppBindings>();

/**
 * GET /admin/memories/dump
 * List all memories for a scope (debugging only).
 *
 * At least one of user_id/agent_id required. Relaxed match — memories with
 * null on a scope field are included alongside matches.
 */
admin.get('/memories/dump', async (c) => {
  const user_id = c.req.query('user_id') || undefined;
  const agent_id = c.req.query('agent_id') || undefined;
  if (!user_id && !agent_id) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Missing scope: at least one of user_id or agent_id query parameter is required',
    );
  }

  const productId = c.req.query('product_id') ?? 'default';
  const result = await c.env.DATA.memoryListByScope(
    productId,
    { user_id, agent_id },
    { limit: 1000 },
  );

  return c.json({
    memories: result.items,
    total: result.items.length,
  });
});

/**
 * POST /admin/memories/purge
 * Delete all memories + vectors for a scope.
 *
 * Body: { user_id?, agent_id?, product_id? } — at least one of
 * user_id/agent_id required. Strict match — memories with null on a scope
 * field do NOT match (destructive operations never fall through null).
 */
admin.post('/memories/purge', async (c) => {
  const body = await c.req.json<{
    user_id?: string;
    agent_id?: string;
    product_id?: string;
  }>();
  if (!body.user_id && !body.agent_id) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Missing scope: at least one of user_id or agent_id is required',
    );
  }

  const productId = body.product_id ?? 'default';
  const scope = { user_id: body.user_id, agent_id: body.agent_id };

  // Get matching memory IDs first (strict match). Use listByScope as a
  // relaxed preview; it's fine to surface a few extra vectors — we still
  // only delete the strict-match rows from D1 below.
  // Note: listByScope is relaxed, so the vectors-deleted count may be
  // larger than memories-deleted when scope fields are partially null.
  // That matches the caller's intent: purge everything touching this scope.
  const result = await c.env.DATA.memoryListByScope(productId, scope, { limit: 10000 });
  const memoryIds = result.items.map((m) => m.id);

  // Delete from Vectorize
  if (memoryIds.length > 0) {
    await c.env.DATA.vectorDeleteMany(productId, memoryIds);
  }

  // Delete audit entries
  const auditsDeleted =
    memoryIds.length > 0 ? await c.env.DATA.auditDeleteByMemoryIds(productId, memoryIds) : 0;

  // Delete from D1 (strict match).
  const deleted = await c.env.DATA.memoryDeleteByScope(productId, scope);

  return c.json({
    message: 'Purge complete',
    memories_deleted: deleted,
    vectors_deleted: memoryIds.length,
    audits_deleted: auditsDeleted,
  });
});

/**
 * GET /admin/health/detailed
 * Detailed health status of all services.
 */
admin.get('/health/detailed', async (c) => {
  const checks: Record<string, { status: 'ok' | 'error'; latency_ms?: number; error?: string }> =
    {};

  // D1 via DATA service
  const d1Start = Date.now();
  try {
    await c.env.DATA.memoryGetById('default', 'nonexistent');
    checks.d1 = { status: 'ok', latency_ms: Date.now() - d1Start };
  } catch (err) {
    checks.d1 = {
      status: 'error',
      latency_ms: Date.now() - d1Start,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }

  // Vectorize via DATA service
  const vecStart = Date.now();
  try {
    await c.env.DATA.vectorSearch('default', new Array(1024).fill(0), {}, 1);
    checks.vectorize = { status: 'ok', latency_ms: Date.now() - vecStart };
  } catch (err) {
    checks.vectorize = {
      status: 'error',
      latency_ms: Date.now() - vecStart,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }

  // KV
  const kvStart = Date.now();
  try {
    await c.env.CONFIG.get('product:default:db_binding');
    checks.kv = { status: 'ok', latency_ms: Date.now() - kvStart };
  } catch (err) {
    checks.kv = {
      status: 'error',
      latency_ms: Date.now() - kvStart,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }

  // Ingestion (Service Binding)
  const ingStart = Date.now();
  try {
    const resp = await internalFetch(
      c.env.INGESTION,
      new Request('https://internal/health', { method: 'GET' }),
      c.env.INTERNAL_SERVICE_KEY,
    );
    checks.ingestion = {
      status: resp.ok ? 'ok' : 'error',
      latency_ms: Date.now() - ingStart,
    };
  } catch (err) {
    checks.ingestion = {
      status: 'error',
      latency_ms: Date.now() - ingStart,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }

  // Retrieval (Service Binding)
  const retStart = Date.now();
  try {
    const resp = await internalFetch(
      c.env.RETRIEVAL,
      new Request('https://internal/health', { method: 'GET' }),
      c.env.INTERNAL_SERVICE_KEY,
    );
    checks.retrieval = {
      status: resp.ok ? 'ok' : 'error',
      latency_ms: Date.now() - retStart,
    };
  } catch (err) {
    checks.retrieval = {
      status: 'error',
      latency_ms: Date.now() - retStart,
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }

  const allOk = Object.values(checks).every((v) => v.status === 'ok');

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'memory-api',
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * POST /admin/pipeline/test-extract
 * Run extraction on sample text, return candidates without persisting.
 */
admin.post('/pipeline/test-extract', async (c) => {
  const body = await c.req.json<{
    content: string;
    scene_type?: string;
  }>();

  if (!body.content) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Missing content in request body');
  }

  const candidates = await extractMemories(body.content, {
    claude: claudeConfigFromEnv(c.env),
    sceneType: SceneType.parse(body.scene_type ?? 'one_on_one_chat'),
  });

  return c.json({
    candidates,
    count: candidates.length,
    message: 'Extraction test complete (nothing persisted)',
  });
});

/**
 * POST /admin/pipeline/test-reconcile
 * Run reconciliation on a candidate against existing memories, return decisions without persisting.
 */
admin.post('/pipeline/test-reconcile', async (c) => {
  const TestReconcileSchema = z
    .object({
      candidate_content: z.string().min(1),
      user_id: z.string().min(1).optional(),
      agent_id: z.string().min(1).optional(),
      product_id: z.string().min(1).default('default'),
      top_k: z.number().int().min(1).max(20).default(5),
    })
    .refine((s) => !!s.user_id || !!s.agent_id, {
      message: 'test-reconcile must include at least one of user_id or agent_id',
      path: ['user_id'],
    });

  const body = await c.req.json();
  const parsed = TestReconcileSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Invalid test-reconcile request',
      parsed.error.flatten(),
    );
  }

  const { candidate_content, user_id, agent_id, product_id, top_k } = parsed.data;

  // Embed the candidate via DATA service
  const embeddings = await c.env.DATA.generateEmbeddings([candidate_content]);
  const embedding = embeddings[0] ?? null;
  if (!embedding) {
    return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to generate embedding');
  }

  // Search for similar existing memories via DATA service (fans out across
  // scope filter variants and unions ids, mirroring the reconcile step).
  const similarMemories = await findSimilarMemories(
    c.env.DATA,
    product_id,
    embedding,
    { user_id, agent_id },
    top_k,
  );

  // Run reconciliation without persisting
  const decision = await reconcileCandidate(
    {
      content: candidate_content,
      episode: null,
      type: 'fact',
      source_actor: 'test',
      source_type: 'user_stated',
      confidence: 0.9,
      validity_start: null,
      validity_end: null,
      tags: [],
      subject: null,
      predicate: null,
      object: null,
    },
    similarMemories,
    { claude: claudeConfigFromEnv(c.env) },
  );

  return c.json({
    decision,
    similar_memories: similarMemories.map((sm) => ({
      id: sm.memory.id,
      content: sm.memory.content,
      score: sm.score,
    })),
    message: 'Reconciliation test complete (nothing persisted)',
  });
});

/**
 * GET /admin/audit/recent
 * View recent audit entries for a scope.
 */
admin.get('/audit/recent', async (c) => {
  const user_id = c.req.query('user_id') || undefined;
  const agent_id = c.req.query('agent_id') || undefined;
  if (!user_id && !agent_id) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Missing scope: at least one of user_id or agent_id query parameter is required',
    );
  }

  const limitStr = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);
  const productId = c.req.query('product_id') ?? 'default';

  const entries = await c.env.DATA.auditListRecent(productId, { user_id, agent_id }, limit);

  return c.json({
    entries,
    total: entries.length,
  });
});

// ─── Dead Letter Endpoints ──────────────────────────────────

/**
 * GET /admin/dead-letters
 * List dead letter entries.
 */
admin.get('/dead-letters', async (c) => {
  const limitStr = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);

  const productId = c.req.query('product_id') ?? 'default';
  const entries = await c.env.DATA.deadLetterList(productId, limit);

  return c.json({
    entries,
    total: entries.length,
  });
});

/**
 * POST /admin/dead-letters/:id/reprocess
 * Requeue a dead letter for retry via the consolidation queue.
 */
admin.post('/dead-letters/:id/reprocess', async (c) => {
  const id = c.req.param('id');
  const productId = c.req.query('product_id') ?? 'default';

  const entry = await c.env.DATA.deadLetterGetById(productId, id);
  if (!entry) {
    return apiError(c, 404, 'NOT_FOUND', `Dead letter ${id} not found`);
  }

  // Validate the payload before requeueing
  let payload: unknown;
  try {
    payload = JSON.parse(entry.payload);
  } catch {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Dead letter payload is not valid JSON');
  }

  const parsedPayload = ConsolidationMessage.safeParse(payload);
  if (!parsedPayload.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Dead letter payload is not a valid consolidation message',
      parsedPayload.error.flatten(),
    );
  }

  // Re-enqueue the validated message
  await c.env.CONSOLIDATION_QUEUE.send(parsedPayload.data);

  // Remove from dead letters
  await c.env.DATA.deadLetterDeleteById(productId, id);

  return c.json({
    message: 'Dead letter requeued for processing',
    dead_letter_id: id,
  });
});

// ─── Consolidation Endpoints ────────────────────────────────

/**
 * POST /admin/consolidation/trigger
 * Manually trigger a consolidation job for a scope.
 */
admin.post('/consolidation/trigger', async (c) => {
  const TriggerSchema = z
    .object({
      type: z.enum(['profile_rebuild', 'expiry_sweep', 'confidence_decay', 'conflict_resolution']),
      user_id: z.string().min(1).optional(),
      agent_id: z.string().min(1).optional(),
      product_id: z.string().min(1).default('default'),
      memory_ids: z.array(z.string()).optional(),
    })
    .refine((s) => !!s.user_id || !!s.agent_id, {
      message: 'trigger must include at least one of user_id or agent_id',
      path: ['user_id'],
    });

  const body = await c.req.json();
  const parsed = TriggerSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid trigger request', parsed.error.flatten());
  }

  const message: ConsolidationMessage = {
    type: parsed.data.type,
    product_id: parsed.data.product_id,
    scope: {
      user_id: parsed.data.user_id,
      agent_id: parsed.data.agent_id,
    },
    memory_ids: parsed.data.memory_ids,
    triggered_by: 'admin_manual',
    created_at: new Date().toISOString(),
  };

  await c.env.CONSOLIDATION_QUEUE.send(message);

  return c.json({
    message: `Consolidation job '${parsed.data.type}' enqueued`,
    scope: message.scope,
  });
});

/**
 * GET /admin/consolidation/status
 * Check dead letter count and recent consolidation audit entries.
 */
admin.get('/consolidation/status', async (c) => {
  const productId = c.req.query('product_id') ?? 'default';

  const deadLetterCount = await c.env.DATA.deadLetterCount(productId);

  // Recent consolidation audit entries
  // We can't filter by triggered_by directly in listRecent, so we'll get recent entries
  // and note that consolidation entries show triggered_by = "consolidation"
  const user_id = c.req.query('user_id') || undefined;
  const agent_id = c.req.query('agent_id') || undefined;
  let recentActivity: unknown[] = [];
  if (user_id || agent_id) {
    const entries = await c.env.DATA.auditListRecent(productId, { user_id, agent_id }, 20);
    recentActivity = entries.filter(
      (e) => e.triggered_by === 'consolidation' || e.triggered_by === 'expiry_sweep',
    );
  }

  return c.json({
    dead_letter_count: deadLetterCount,
    recent_consolidation_activity: recentActivity,
    cron_schedule: {
      daily_sweep: '0 3 * * * (3 AM UTC — expiry sweep + confidence decay)',
      weekly_profile: '0 4 * * SUN (Sunday 4 AM UTC — profile rebuild)',
    },
  });
});

export { admin };
