/**
 * Idempotency double-send over REAL local D1.
 *
 * test/middleware/idempotency.test.ts pins the middleware's control flow
 * against a recording stub; this suite replaces the stub with a real
 * DataService over real D1, so the replay guarantee is proven end to end:
 * middleware → DATA RPC surface → D1IdempotencyRepository → idempotency_keys.
 */
import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
// Applies migrations and registers the per-test table wipe (see file header).
import '../apply-migrations';
import { Hono } from 'hono';
import { DataService } from '@deeprecall/worker-data';
import { idempotencyMiddleware } from '../../src/middleware/idempotency';
import type { AppBindings } from '../../src/types';

type DataEnv = ConstructorParameters<typeof DataService>[1];

function makeHarness() {
  // Real DataService over real local D1. Both product ids route to the SAME
  // physical database on purpose: that is the worst case for cross-tenant
  // replay, so the product-scoping test proves the key prefix alone keeps
  // tenants apart even when they share storage.
  const service = new DataService(createExecutionContext(), {
    DB_default: env.DB_default,
    DB_other: env.DB_default,
  } as DataEnv);

  let sequence = 0;
  const handler = vi.fn((c: Parameters<Parameters<Hono<AppBindings>['post']>[1]>[0]) => {
    sequence += 1;
    return c.json({ result: 'fresh', sequence }, 202);
  });

  const app = new Hono<AppBindings>();
  // Auth normally sets product_id before idempotency runs; the test drives
  // it via a header so one app can simulate two tenants.
  app.use('/*', async (c, next) => {
    c.set('product_id', c.req.header('x-test-product') ?? 'default');
    await next();
  });
  app.post('/ingest', idempotencyMiddleware, handler);

  const request = (headers: Record<string, string> = {}) =>
    app.request('/ingest', { method: 'POST', headers }, {
      DATA: service,
    } as unknown as AppBindings['Bindings']);

  return { service, handler, request };
}

describe('idempotency double-send over real D1', () => {
  it('replays the first response on a duplicate send and runs the handler exactly once', async () => {
    const { handler, request } = makeHarness();

    const first = await request({ 'idempotency-key': 'send-1' });
    expect(first.status).toBe(202);
    expect(first.headers.get('x-idempotency-status')).toBe('stored');
    const firstBody = await first.json();
    expect(firstBody).toEqual({ result: 'fresh', sequence: 1 });

    const second = await request({ 'idempotency-key': 'send-1' });
    expect(second.status).toBe(202);
    expect(second.headers.get('x-idempotency-status')).toBe('cached');
    // Exact replay of the first body — not a re-execution.
    expect(await second.json()).toEqual(firstBody);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('a different idempotency key executes the handler again', async () => {
    const { handler, request } = makeHarness();

    await request({ 'idempotency-key': 'key-a' });
    const res = await request({ 'idempotency-key': 'key-b' });

    expect(res.headers.get('x-idempotency-status')).toBe('stored');
    expect(await res.json()).toEqual({ result: 'fresh', sequence: 2 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('the same key under a different product_id executes the handler (product scoping)', async () => {
    const { handler, request } = makeHarness();

    const first = await request({ 'idempotency-key': 'shared-key' });
    expect(first.headers.get('x-idempotency-status')).toBe('stored');

    // Same key, different tenant, SAME physical D1 — must not replay.
    const other = await request({ 'idempotency-key': 'shared-key', 'x-test-product': 'other' });
    expect(other.headers.get('x-idempotency-status')).toBe('stored');
    expect(await other.json()).toEqual({ result: 'fresh', sequence: 2 });
    expect(handler).toHaveBeenCalledTimes(2);

    // Each tenant now replays its own cached copy.
    const replay = await request({ 'idempotency-key': 'shared-key', 'x-test-product': 'other' });
    expect(replay.headers.get('x-idempotency-status')).toBe('cached');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('stores a 24h TTL and stops replaying once the key expires', async () => {
    const { service, request } = makeHarness();

    await request({ 'idempotency-key': 'ttl-key' });

    // The row carries the middleware's 24h TTL.
    const row = await env.DB_default.prepare(
      'SELECT created_at, expires_at FROM idempotency_keys WHERE key = ?',
    )
      .bind('default:ttl-key')
      .first<{ created_at: string; expires_at: string }>();
    expect(row).not.toBeNull();
    const ttlMs = new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime();
    expect(ttlMs).toBe(24 * 60 * 60 * 1000);

    // Unexpired: cleanup removes nothing.
    expect(await service.idempotencyCleanup('default')).toBe(0);

    // Force-expire the row, as the expiry sweep would find it a day later.
    await env.DB_default.prepare('UPDATE idempotency_keys SET expires_at = ? WHERE key = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), 'default:ttl-key')
      .run();

    // Expired keys no longer replay (check filters on expires_at) and the
    // cleanup sweep deletes exactly that row.
    expect(await service.idempotencyCheck('default', 'default:ttl-key')).toBeNull();
    expect(await service.idempotencyCleanup('default')).toBe(1);
  });
});
