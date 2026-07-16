import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { authorizeScope } from '../auth/scope-check';

export const inspect = new Hono<AppBindings>();

/**
 * GET /v1/inspect/:memory_id
 * Full memory record with provenance, audit trail, and superseded_by chain.
 *
 * Scope is required (user_id and/or agent_id query params, at least one) so
 * callers can only inspect memories they own. Prior to agent-scoping, this
 * endpoint accepted any memory_id within the authenticated product — a leak
 * that let any caller inspect any memory by id.
 *
 * On unauthorized access: 403 (not 404) — random UUIDs make existence-
 * probing infeasible, and 403 is clearer to legitimate callers mis-scoping
 * a request.
 */
inspect.get('/:memory_id', async (c) => {
  const memoryId = c.req.param('memory_id');
  const productId = c.get('product_id');

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

  const memory = await c.env.DATA.memoryGetById(productId, memoryId);
  if (!memory) {
    return apiError(c, 404, 'NOT_FOUND', `Memory ${memoryId} not found`);
  }

  if (!authorizeScope(memory, { user_id, agent_id })) {
    return apiError(
      c,
      403,
      'AUTHENTICATION_ERROR',
      'Memory does not belong to the specified scope',
    );
  }

  // Fetch audit trail
  const auditTrail = await c.env.DATA.auditGetByMemoryId(productId, memoryId);

  // Build superseded_by chain (follow the chain of superseded memories)
  const supersededChain: string[] = [];
  let currentId: string | null = memory.superseded_by;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    supersededChain.push(currentId);
    const next = await c.env.DATA.memoryGetById(productId, currentId);
    currentId = next?.superseded_by ?? null;
  }

  return c.json({
    memory,
    audit_trail: auditTrail,
    superseded_by_chain: supersededChain,
  });
});
