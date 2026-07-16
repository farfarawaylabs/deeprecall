import { createMiddleware } from 'hono/factory';
import { sha256Hex, apiError } from '@deeprecall/http';
import type { AppBindings } from '../types';

/**
 * API key authentication middleware.
 * Reads X-API-Key, hashes it, and resolves the product via a single KV lookup
 * on `apikey:<sha256(key)>`. Keys are never stored in plaintext, and resolution
 * is O(1) regardless of tenant count — an unknown/garbage key is a single failed
 * lookup, not a scan of every product. Sets product_id and trace_id in context.
 *
 * The hash is a straight SHA-256 (no salt): API keys are 122-bit random UUIDs,
 * so they are not subject to dictionary/rainbow-table attacks. No timing-safe
 * compare is needed — the KV lookup by hash replaces the byte-by-byte compare.
 */
export const apiKeyAuth = createMiddleware<AppBindings>(async (c, next) => {
  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    return apiError(c, 401, 'AUTHENTICATION_ERROR', 'Missing X-API-Key header');
  }

  const hash = await sha256Hex(apiKey);
  const matchedProductId = await c.env.CONFIG.get(`apikey:${hash}`);

  if (!matchedProductId) {
    return apiError(c, 401, 'AUTHENTICATION_ERROR', 'Invalid API key');
  }

  c.set('product_id', matchedProductId);

  // Enrich log context with product_id (trace_id already set by logging middleware)
  const ctx = c.get('log_ctx');
  if (ctx) {
    ctx.product_id = matchedProductId;
  }

  await next();
});
