import { IngestionRequest } from '@deeprecall/types';
import { z } from 'zod';
import { Logger } from '@deeprecall/logger';
import type { IngestionPayload, IngestionResult } from './types';
import { verifyInternalKey, errorResponse } from '@deeprecall/http';

// Re-export the workflow class so Cloudflare can discover it
export { IngestionWorkflow } from './workflow';

/**
 * Envelope posted by memory-api (via Service Binding).
 * product_id is lifted out of the request body; auth middleware in
 * memory-api injects it from the API key — callers cannot spoof it.
 */
const IngestionEnvelope = z.object({ product_id: z.string().min(1) }).and(IngestionRequest);

const INSTANCE_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function summarize(result: IngestionResult): string {
  if (result.candidates_persisted > 0) {
    return `Persisted ${result.candidates_persisted} memor${result.candidates_persisted === 1 ? 'y' : 'ies'}.`;
  }
  if (result.candidates_extracted === 0) {
    return 'No memory candidates were extracted from the content.';
  }
  if (result.candidates_approved === 0) {
    return `All ${result.candidates_extracted} extracted candidate${result.candidates_extracted === 1 ? ' was' : 's were'} rejected by policy. See rejections for details.`;
  }
  return `${result.candidates_approved} of ${result.candidates_extracted} candidates passed policy, but none were persisted (reconcile skipped them as duplicates or conflicting with pinned memories).`;
}

async function handleStatus(
  request: Request,
  env: Env,
  pathname: string,
  logCtx: ReturnType<typeof Logger.createContext>,
): Promise<Response> {
  const instanceId = pathname.slice('/status/'.length);
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid instance_id format');
  }

  try {
    const instance = await env.INGESTION_WORKFLOW.get(instanceId);
    const status = await instance.status();

    // status.status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waitingForEvent" | "waiting" | "unknown"
    const output =
      status.status === 'complete' && status.output ? (status.output as IngestionResult) : null;

    return Response.json({
      instance_id: instanceId,
      status: status.status,
      result: output,
      summary: output ? summarize(output) : null,
      error: status.status === 'errored' && 'error' in status ? String(status.error) : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.warn(logCtx, 'Workflow instance lookup failed', {
      instance_id: instanceId,
      error: message,
    });
    // Cloudflare throws when the instance doesn't exist — surface as 404.
    return errorResponse(404, 'NOT_FOUND', `Workflow instance ${instanceId} not found`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Reject before doing any work if the internal shared-secret is missing/wrong.
    // Denials are intentionally not logged: this runs before the Logger context
    // is built, and logging every rejected probe would let an attacker drive log
    // volume. A botched key rotation surfaces as 502s at the memory-api boundary.
    const denied = verifyInternalKey(request, env.INTERNAL_SERVICE_KEY);
    if (denied) return denied;

    const traceId = request.headers.get('x-trace-id') ?? undefined;
    const logCtx = Logger.createContext('ingestion', { trace_id: traceId });
    const axiomConfig =
      env.AXIOM_API_TOKEN && env.AXIOM_DATASET
        ? { apiToken: env.AXIOM_API_TOKEN, dataset: env.AXIOM_DATASET }
        : undefined;

    const url = new URL(request.url);

    try {
      // GET /status/<instance_id> — lookup workflow outcome.
      if (request.method === 'GET' && url.pathname.startsWith('/status/')) {
        return await handleStatus(request, env, url.pathname, logCtx);
      }

      if (request.method !== 'POST') {
        return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }

      const body = await request.json();
      const parsed = IngestionEnvelope.safeParse(body);

      if (!parsed.success) {
        Logger.warn(logCtx, 'Invalid ingestion request', {
          errors: parsed.error.flatten(),
        });
        return errorResponse(400, 'VALIDATION_ERROR', 'Invalid ingestion request', {
          details: parsed.error.flatten(),
        });
      }

      const { product_id, ...ingestionRequest } = parsed.data;

      const payload: IngestionPayload = {
        ...ingestionRequest,
        product_id,
        trace_id: logCtx.trace_id,
      };

      logCtx.product_id = product_id;
      logCtx.user_id = ingestionRequest.scope.user_id;
      if (ingestionRequest.scope.agent_id) {
        (logCtx as Record<string, unknown>).agent_id = ingestionRequest.scope.agent_id;
      }

      // Create a workflow instance
      const instance = await env.INGESTION_WORKFLOW.create({
        params: payload,
      });

      Logger.info(logCtx, 'Ingestion workflow started', {
        instance_id: instance.id,
      });

      return Response.json({
        instance_id: instance.id,
        status: 'queued',
        message: 'Ingestion workflow started',
      });
    } catch (err) {
      Logger.error(logCtx, 'Ingestion worker error', {
        error: err instanceof Error ? err.message : String(err),
      });

      return errorResponse(500, 'INTERNAL_ERROR', 'Ingestion worker error');
    } finally {
      if (axiomConfig) {
        ctx.waitUntil(Logger.flush(logCtx, axiomConfig));
      }
    }
  },
} satisfies ExportedHandler<Env>;
