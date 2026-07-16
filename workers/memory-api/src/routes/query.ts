import { Hono } from 'hono';
import { QueryRequest } from '@deeprecall/types';
import type { AppBindings } from '../types';
import { internalFetch, apiError } from '@deeprecall/http';

const query = new Hono<AppBindings>();

/**
 * POST /v1/query
 * Validate request, forward to retrieval worker via Service Binding.
 *
 * product_id is injected from the API key (auth middleware). Callers cannot
 * spoof it via the request body.
 */
query.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = QueryRequest.safeParse(body);

  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid request body', parsed.error.flatten());
  }

  // Build service-binding envelope. product_id comes from auth, not body.
  const envelope = {
    product_id: c.get('product_id'),
    ...parsed.data,
  };

  const response = await internalFetch(
    c.env.RETRIEVAL,
    new Request('https://internal/query', {
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

  return c.json(result);
});

export { query };
