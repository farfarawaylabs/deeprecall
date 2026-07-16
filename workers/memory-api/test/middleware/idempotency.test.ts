import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { idempotencyMiddleware } from '../../src/middleware/idempotency';
import type { AppBindings } from '../../src/types';

function makeHarness(options?: { cached?: string | null; handlerStatus?: number }) {
  const dataStub = {
    idempotencyCheck: vi.fn().mockResolvedValue(options?.cached ?? null),
    idempotencyStore: vi.fn().mockResolvedValue(undefined),
  };
  const handler = vi.fn((c: Parameters<Parameters<Hono<AppBindings>['post']>[1]>[0]) =>
    c.json({ result: 'fresh' }, (options?.handlerStatus ?? 200) as 200),
  );

  const app = new Hono<AppBindings>();
  // Auth normally sets product_id before idempotency runs.
  app.use('/*', async (c, next) => {
    c.set('product_id', 'p_test');
    await next();
  });
  app.post('/ingest', idempotencyMiddleware, handler);

  const request = (headers: Record<string, string> = {}) =>
    app.request('/ingest', { method: 'POST', headers }, {
      DATA: dataStub,
    } as unknown as AppBindings['Bindings']);

  return { dataStub, handler, request };
}

describe('idempotencyMiddleware', () => {
  it('skips entirely when no idempotency-key header is present', async () => {
    const { dataStub, handler, request } = makeHarness();
    const res = await request();

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(dataStub.idempotencyCheck).not.toHaveBeenCalled();
    expect(dataStub.idempotencyStore).not.toHaveBeenCalled();
    expect(res.headers.get('x-idempotency-status')).toBeNull();
  });

  it('replays a cached response without invoking the handler', async () => {
    const cached = JSON.stringify({ body: { result: 'from-cache' }, status: 201 });
    const { dataStub, handler, request } = makeHarness({ cached });

    const res = await request({ 'idempotency-key': 'abc' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ result: 'from-cache' });
    expect(res.headers.get('x-idempotency-status')).toBe('cached');
    expect(handler).not.toHaveBeenCalled();
    expect(dataStub.idempotencyStore).not.toHaveBeenCalled();
  });

  it('scopes the key by product_id to prevent cross-tenant replay collisions', async () => {
    const { dataStub, request } = makeHarness();
    await request({ 'idempotency-key': 'abc' });

    expect(dataStub.idempotencyCheck).toHaveBeenCalledWith('p_test', 'p_test:abc');
  });

  it('stores a fresh 2xx response with the 24h TTL and marks it stored', async () => {
    const { dataStub, request } = makeHarness();
    const res = await request({ 'idempotency-key': 'abc' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-idempotency-status')).toBe('stored');
    expect(dataStub.idempotencyStore).toHaveBeenCalledOnce();
    const [productId, key, entry, ttl] = dataStub.idempotencyStore.mock.calls[0];
    expect(productId).toBe('p_test');
    expect(key).toBe('p_test:abc');
    expect(JSON.parse(entry)).toEqual({ body: { result: 'fresh' }, status: 200 });
    expect(ttl).toBe(24);
  });

  it('does not cache non-2xx responses', async () => {
    const { dataStub, request } = makeHarness({ handlerStatus: 422 });
    const res = await request({ 'idempotency-key': 'abc' });

    expect(res.status).toBe(422);
    expect(dataStub.idempotencyStore).not.toHaveBeenCalled();
    expect(res.headers.get('x-idempotency-status')).toBeNull();
  });
});
