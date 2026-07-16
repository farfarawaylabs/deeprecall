import type { Context, Next } from 'hono';
import type { AppBindings } from '../types';

const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Idempotency middleware for ingest endpoints.
 * Checks for an `idempotency-key` header.
 * If a cached response exists for that key, returns it immediately.
 * Otherwise, lets the request proceed and caches only 2xx responses.
 * Keys are scoped by product_id to prevent cross-tenant collisions.
 */
export async function idempotencyMiddleware(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const headerKey = c.req.header('idempotency-key');

  // If no idempotency key provided, skip middleware
  if (!headerKey) {
    return next();
  }

  // Scope key by product_id to prevent cross-tenant collisions
  const productId = c.get('product_id');
  const idempotencyKey = productId ? `${productId}:${headerKey}` : headerKey;

  // Check for existing response via DATA service binding
  const cachedResponse = await c.env.DATA.idempotencyCheck(productId, idempotencyKey);
  if (cachedResponse) {
    const parsed = JSON.parse(cachedResponse);
    c.header('x-idempotency-status', 'cached');
    return c.json(parsed.body, parsed.status);
  }

  // Let the request proceed
  await next();

  // Only cache successful (2xx) responses
  if (c.res.status >= 200 && c.res.status < 300) {
    const responseBody = await c.res.clone().text();
    const cacheEntry = JSON.stringify({
      body: JSON.parse(responseBody),
      status: c.res.status,
    });

    await c.env.DATA.idempotencyStore(productId, idempotencyKey, cacheEntry, IDEMPOTENCY_TTL_HOURS);
    c.header('x-idempotency-status', 'stored');
  }
}
