import { Hono } from 'hono';
import { IngestionRequest } from '@deeprecall/types';
import type { AppBindings } from '../types';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { internalFetch, apiError } from '@deeprecall/http';

const ingest = new Hono<AppBindings>();

/**
 * POST /v1/ingest
 * Validate request, forward to ingestion worker via Service Binding.
 * Supports idempotency via `idempotency-key` header.
 *
 * product_id is injected from the API key (auth middleware). Callers cannot
 * spoof it via the request body — Zod strips unknown keys from Scope.
 */
ingest.post('/', idempotencyMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = IngestionRequest.safeParse(body);

  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid request body', parsed.error.flatten());
  }

  // Build service-binding envelope. product_id comes from auth, not body.
  const envelope = {
    product_id: c.get('product_id'),
    ...parsed.data,
  };

  const response = await internalFetch(
    c.env.INGESTION,
    new Request('https://internal/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-trace-id': c.get('trace_id'),
      },
      body: JSON.stringify(envelope),
    }),
    c.env.INTERNAL_SERVICE_KEY,
  );

  const result = await response.json();

  if (!response.ok) {
    return c.json(result, response.status as 400 | 500 | 502);
  }

  return c.json(result, 202);
});

/**
 * GET /v1/ingest/status/:instance_id
 *
 * Poll for the outcome of an async ingestion. Returns the workflow status
 * plus a summary that distinguishes "no candidates extracted" from "all
 * rejected by policy" from "successfully persisted".
 *
 * Useful right after POST /v1/ingest to see *why* N memories landed (or
 * didn't) in the store without having to inspect D1 or the workflow logs.
 */
ingest.get('/status/:instance_id', async (c) => {
  const instanceId = c.req.param('instance_id');

  const response = await internalFetch(
    c.env.INGESTION,
    new Request(`https://internal/status/${encodeURIComponent(instanceId)}`, {
      method: 'GET',
      headers: {
        'x-trace-id': c.get('trace_id'),
      },
    }),
    c.env.INTERNAL_SERVICE_KEY,
  );

  const result = await response.json();
  return c.json(result, response.status as 200 | 400 | 404 | 500 | 502);
});

export { ingest };
