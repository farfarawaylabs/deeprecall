import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { sha256Hex } from '@deeprecall/http';

const ADMIN = { 'X-Admin-Key': 'test-admin-key' };
const PRODUCT = 'test-product';

describe('POST /admin/products/:id/rotate-key', () => {
  beforeEach(async () => {
    const list = await env.CONFIG.list();
    for (const k of list.keys) await env.CONFIG.delete(k.name);
  });

  it('returns 404 for an unregistered product', async () => {
    const res = await SELF.fetch(`http://localhost/admin/products/${PRODUCT}/rotate-key`, {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(404);
  });

  it('installs the new key index, deletes the old, and purges legacy plaintext', async () => {
    // Simulate a product whose key was created before this change (legacy
    // plaintext still present) plus the current hashed index/bookkeeping.
    const oldHash = await sha256Hex('old-key-value');
    await env.CONFIG.put(
      `product:${PRODUCT}:config`,
      JSON.stringify({ product_id: PRODUCT, name: 'x' }),
    );
    await env.CONFIG.put(`apikey:${oldHash}`, PRODUCT);
    await env.CONFIG.put(`product:${PRODUCT}:api_key_hash`, oldHash);
    await env.CONFIG.put(`product:${PRODUCT}:api_key`, 'old-key-value'); // legacy

    const res = await SELF.fetch(`http://localhost/admin/products/${PRODUCT}/rotate-key`, {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { product_id: string; api_key: string };
    expect(body.product_id).toBe(PRODUCT);

    const newHash = await sha256Hex(body.api_key);
    // New key resolves; bookkeeping updated.
    expect(await env.CONFIG.get(`apikey:${newHash}`)).toBe(PRODUCT);
    expect(await env.CONFIG.get(`product:${PRODUCT}:api_key_hash`)).toBe(newHash);
    // Old index entry gone; legacy plaintext purged (so the old key can't resolve
    // on a pre-migration scan-based worker either).
    expect(await env.CONFIG.get(`apikey:${oldHash}`)).toBeNull();
    expect(await env.CONFIG.get(`product:${PRODUCT}:api_key`)).toBeNull();
  });

  it('rejects a missing admin key with 401', async () => {
    const res = await SELF.fetch(`http://localhost/admin/products/${PRODUCT}/rotate-key`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});
