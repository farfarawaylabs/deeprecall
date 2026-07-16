import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { sha256Hex } from '@deeprecall/http';

// Boundary-level checks that every failure mode returns the standard
// { error: { code, message } } envelope and never leaks internals.
const VALID_KEY = 'envelope-test-key-0123456789abcdef';

beforeAll(async () => {
  await env.CONFIG.put(`apikey:${await sha256Hex(VALID_KEY)}`, 'p_envelope');
});

describe('error envelope shape', () => {
  it('401 (missing key) carries code and message only', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toEqual({
      code: 'AUTHENTICATION_ERROR',
      message: 'Missing X-API-Key header',
    });
  });

  it('400 (validation) returns VALIDATION_ERROR with field details', async () => {
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_KEY },
      body: JSON.stringify({}), // missing required "query"
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid request body');
    expect(body.error.details).toBeDefined();
  });

  it('500 (unhandled crash) returns the generic INTERNAL_ERROR envelope without leaking the cause', async () => {
    // A valid request reaches the handler, which crashes on the unbound
    // RETRIEVAL service binding — exercising the global error handler.
    // (Service bindings exist only under env.dev/env.production in
    // wrangler.jsonc, so the test worker deterministically has none.)
    expect((env as Record<string, unknown>).RETRIEVAL).toBeUndefined();
    const res = await SELF.fetch('http://localhost/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VALID_KEY },
      body: JSON.stringify({ query: 'hello', scope: { user_id: 'u1' } }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    // Exactly code + message — a future details/cause field must not slip in.
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    // The generic message, not the underlying error — internals must not leak.
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toMatch(/RETRIEVAL|undefined|stack/i);
  });
});
