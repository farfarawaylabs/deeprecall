import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { sha256Hex } from '@deeprecall/http';

// Auth resolves a product by hashing the presented key and looking up
// apikey:<hash> in CONFIG. These tests seed that index directly.
const VALID_KEY = 'test-product-key-0123456789abcdef';

describe('apiKeyAuth (hashed index lookup)', () => {
  beforeAll(async () => {
    const hash = await sha256Hex(VALID_KEY);
    await env.CONFIG.put(`apikey:${hash}`, 'p_test');
  });

  it('returns 401 when the X-API-Key header is missing', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hi' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTHENTICATION_ERROR');
  });

  it('returns 401 for an unknown key (single failed lookup, no scan)', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'definitely-not-a-real-key' },
      body: JSON.stringify({ query: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('resolves a valid key past auth (does not 401)', async () => {
    // A seeded key passes auth; the request proceeds past the middleware
    // (it may then fail downstream on unbound service bindings — the point is
    // that authentication itself succeeded, i.e. the status is not 401).
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_KEY },
      body: JSON.stringify({ query: 'hi', scope: { user_id: 'u1' } }),
    });
    expect(res.status).not.toBe(401);
  });
});
