import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { apiKeyAuth } from '../../src/middleware/auth';
import { sha256Hex } from '@deeprecall/http';
import type { AppBindings } from '../../src/types';

// Multi-tenant resolution: each key must resolve to exactly its own product.
// A bug here is a cross-tenant auth bypass, so this is pinned at the
// middleware level with a probe route that echoes the resolved product_id.
const KEY_A = 'product-a-key-00000000000000000001';
const KEY_B = 'product-b-key-00000000000000000002';

function makeProbeApp() {
  const app = new Hono<AppBindings>();
  app.use('/*', apiKeyAuth);
  app.get('/probe', (c) => c.json({ product_id: c.get('product_id') }));
  return app;
}

const testEnv = () => ({ CONFIG: env.CONFIG }) as AppBindings['Bindings'];

describe('apiKeyAuth cross-product resolution', () => {
  beforeAll(async () => {
    await env.CONFIG.put(`apikey:${await sha256Hex(KEY_A)}`, 'p_alpha');
    await env.CONFIG.put(`apikey:${await sha256Hex(KEY_B)}`, 'p_beta');
  });

  it("product A's key resolves product A", async () => {
    const res = await makeProbeApp().request(
      '/probe',
      { headers: { 'X-API-Key': KEY_A } },
      testEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product_id: 'p_alpha' });
  });

  it("product B's key resolves product B, never product A", async () => {
    const res = await makeProbeApp().request(
      '/probe',
      { headers: { 'X-API-Key': KEY_B } },
      testEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product_id: 'p_beta' });
  });

  it('a near-miss key (one char off) is rejected, not resolved to a neighbor', async () => {
    const res = await makeProbeApp().request(
      '/probe',
      { headers: { 'X-API-Key': KEY_A.slice(0, -1) + 'X' } },
      testEnv(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    expect(body.error.message).toBe('Invalid API key');
  });
});
