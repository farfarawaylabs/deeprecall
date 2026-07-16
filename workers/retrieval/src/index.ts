import { QueryRequest } from '@deeprecall/types';
import { z } from 'zod';
import { Logger } from '@deeprecall/logger';
import { hybridSearch } from './search/hybrid-search';
import type { RetrievalResponse } from './search/types';
import { verifyInternalKey, errorResponse } from '@deeprecall/http';

/**
 * Envelope posted by memory-api (via Service Binding).
 * product_id is lifted out of the request body; auth middleware in
 * memory-api injects it from the API key — callers cannot spoof it.
 */
const RetrievalEnvelope = z.object({ product_id: z.string().min(1) }).and(QueryRequest);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Reject before doing any work if the internal shared-secret is missing/wrong.
    // Denials are intentionally not logged: this runs before the Logger context
    // is built, and logging every rejected probe would let an attacker drive log
    // volume. A botched key rotation surfaces as 502s at the memory-api boundary.
    const denied = verifyInternalKey(request, env.INTERNAL_SERVICE_KEY);
    if (denied) return denied;

    const traceId = request.headers.get('x-trace-id') ?? undefined;
    const logCtx = Logger.createContext('retrieval', { trace_id: traceId });
    const axiomConfig =
      env.AXIOM_API_TOKEN && env.AXIOM_DATASET
        ? { apiToken: env.AXIOM_API_TOKEN, dataset: env.AXIOM_DATASET }
        : undefined;

    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }

    try {
      const body = await request.json();
      const parsed = RetrievalEnvelope.safeParse(body);

      if (!parsed.success) {
        Logger.warn(logCtx, 'Invalid retrieval request', {
          errors: parsed.error.flatten(),
        });
        return errorResponse(400, 'VALIDATION_ERROR', 'Invalid retrieval request', {
          details: parsed.error.flatten(),
        });
      }

      const { product_id, ...queryRequest } = parsed.data;
      logCtx.product_id = product_id;
      logCtx.user_id = queryRequest.scope.user_id;
      // Surface agent_id in logs for agent-scoped retrieval.
      if (queryRequest.scope.agent_id) {
        (logCtx as Record<string, unknown>).agent_id = queryRequest.scope.agent_id;
      }

      const results = await Logger.timed(logCtx, 'hybrid-search', () =>
        hybridSearch(queryRequest, env.DATA, product_id),
      );

      const response: RetrievalResponse = {
        memories: results,
        total: results.length,
        mode: queryRequest.mode,
      };

      return Response.json(response);
    } catch (err) {
      Logger.error(logCtx, 'Retrieval failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      return errorResponse(500, 'INTERNAL_ERROR', 'Retrieval failed');
    } finally {
      if (axiomConfig) {
        ctx.waitUntil(Logger.flush(logCtx, axiomConfig));
      }
    }
  },
} satisfies ExportedHandler<Env>;
