import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import { MemoryStatus, MemoryType } from '@deeprecall/types';
import type { AppBindings } from '../types';

export const memories = new Hono<AppBindings>();

/**
 * GET /v1/memories
 * List memories with optional scope filters (user_id and/or agent_id),
 * status filter, type filter, `since` window (created_at >= since), and
 * cursor pagination.
 *
 * Scope uses relaxed matching when provided — memories with null on a
 * scope field are included alongside memories that match the caller's
 * value. See packages/db/src/repositories/memory-repository.ts
 * #buildRelaxedScopeWhere. When no scope keys are provided, the response
 * is product-wide; pair with `since` for sync/ETL pulls.
 */
memories.get('/', async (c) => {
  const user_id = c.req.query('user_id') || undefined;
  const agent_id = c.req.query('agent_id') || undefined;

  const statusParam = c.req.query('status');
  const typeParam = c.req.query('type');
  const sinceParam = c.req.query('since');

  const status = statusParam
    ? MemoryStatus.safeParse(statusParam).success
      ? (statusParam as MemoryStatus)
      : undefined
    : undefined;
  const type = typeParam
    ? MemoryType.safeParse(typeParam).success
      ? (typeParam as MemoryType)
      : undefined
    : undefined;

  if (statusParam && !status) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      `Invalid status: ${statusParam}. Must be one of: active, superseded, expired, archived, suppressed`,
    );
  }
  if (typeParam && !type) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      `Invalid type: ${typeParam}. Must be one of: fact, episode, foresight, profile`,
    );
  }
  // Strict ISO 8601: 2026-05-17T13:00:00Z or 2026-05-17T13:00:00.123+02:00.
  // `new Date()` alone accepts loose forms ("2026", "May 17 2026") that
  // would silently widen the window.
  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  let since: string | undefined;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (!ISO_8601.test(sinceParam) || Number.isNaN(parsed.getTime())) {
      return apiError(
        c,
        400,
        'VALIDATION_ERROR',
        `Invalid since: ${sinceParam}. Must be an ISO 8601 timestamp (e.g. 2026-05-17T13:00:00Z).`,
      );
    }
    since = parsed.toISOString();
  }

  const cursor = c.req.query('cursor');
  const limitStr = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitStr ?? '20', 10) || 20, 1), 100);

  const productId = c.get('product_id');
  const result = await c.env.DATA.memoryListByScope(
    productId,
    { user_id, agent_id, status, type, since },
    { cursor, limit },
  );

  return c.json({
    memories: result.items,
    cursor: result.cursor,
    total: result.items.length,
  });
});
