import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { sha256Hex } from '@deeprecall/http';

const ADMIN = { 'X-Admin-Key': 'test-admin-key' };

async function seedPlaintext(productId: string, key: string) {
  await env.CONFIG.put(`product:${productId}:api_key`, key);
}

describe('POST /admin/products/migrate-key-index', () => {
  beforeEach(async () => {
    // Clear any keys a prior test left behind.
    const list = await env.CONFIG.list();
    for (const k of list.keys) await env.CONFIG.delete(k.name);
  });

  it('rejects a missing/invalid admin key with 401', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/migrate-key-index', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('backfills the hashed index + bookkeeping from legacy plaintext keys', async () => {
    await seedPlaintext('p1', 'key-one');
    await seedPlaintext('p2', 'key-two');

    const res = await SELF.fetch('http://localhost/admin/products/migrate-key-index', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { migrated: number; cleanup: boolean };
    expect(body.migrated).toBe(2);
    expect(body.cleanup).toBe(false);

    const h1 = await sha256Hex('key-one');
    expect(await env.CONFIG.get(`apikey:${h1}`)).toBe('p1');
    expect(await env.CONFIG.get('product:p1:api_key_hash')).toBe(h1);
    // Without cleanup, the legacy plaintext is left in place (old auth still reads it).
    expect(await env.CONFIG.get('product:p1:api_key')).toBe('key-one');
  });

  it('is idempotent - re-running produces the same index', async () => {
    await seedPlaintext('p1', 'key-one');
    await SELF.fetch('http://localhost/admin/products/migrate-key-index', {
      method: 'POST',
      headers: ADMIN,
    });
    const res = await SELF.fetch('http://localhost/admin/products/migrate-key-index', {
      method: 'POST',
      headers: ADMIN,
    });
    const body = (await res.json()) as { migrated: number };
    expect(body.migrated).toBe(1);
    expect(await env.CONFIG.get(`apikey:${await sha256Hex('key-one')}`)).toBe('p1');
  });

  it('cleanup=true deletes the legacy plaintext after indexing', async () => {
    await seedPlaintext('p1', 'key-one');
    const res = await SELF.fetch('http://localhost/admin/products/migrate-key-index?cleanup=true', {
      method: 'POST',
      headers: ADMIN,
    });
    const body = (await res.json()) as { migrated: number; cleanup: boolean };
    expect(body.migrated).toBe(1);
    expect(body.cleanup).toBe(true);
    expect(await env.CONFIG.get('product:p1:api_key')).toBeNull();
    expect(await env.CONFIG.get(`apikey:${await sha256Hex('key-one')}`)).toBe('p1');
  });
});
