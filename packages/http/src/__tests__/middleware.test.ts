import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { apiError, errorResponse } from '../api-error';
import { createAdminKeyAuth } from '../admin-auth';
import { createErrorHandler } from '../error-handler';
import type { HttpEnv } from '../types';

describe('apiError', () => {
  const app = new Hono<HttpEnv>();
  app.get('/plain', (c) => apiError(c, 404, 'NOT_FOUND', 'Missing'));
  app.get('/details', (c) => apiError(c, 400, 'VALIDATION_ERROR', 'Bad', { field: 'x' }));

  it('builds the standard envelope', async () => {
    const res = await app.request('/plain');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Missing' } });
  });

  it('includes details only when provided', async () => {
    const res = await app.request('/details');
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Bad', details: { field: 'x' } },
    });
  });
});

describe('errorResponse', () => {
  it('builds the same envelope outside Hono, with optional headers', async () => {
    const res = errorResponse(500, 'INTERNAL_MISCONFIGURED', 'Not configured', {
      headers: { 'X-Internal-Auth-Failure': '1' },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Internal-Auth-Failure')).toBe('1');
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_MISCONFIGURED', message: 'Not configured' },
    });
  });
});

describe('createAdminKeyAuth', () => {
  const request = (headers: Record<string, string>, adminKey?: string) => {
    const app = new Hono<HttpEnv>();
    app.use('/*', createAdminKeyAuth());
    app.get('/probe', (c) => c.json({ ok: true }));
    return app.request('/probe', { headers }, { ADMIN_KEY: adminKey });
  };

  it('accepts the correct key', async () => {
    expect((await request({ 'X-Admin-Key': 'k' }, 'k')).status).toBe(200);
  });

  it('rejects a missing header with the exact envelope', async () => {
    const res = await request({}, 'k');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'AUTHENTICATION_ERROR', message: 'Missing X-Admin-Key header' },
    });
  });

  it('rejects a wrong key of a different length', async () => {
    expect((await request({ 'X-Admin-Key': 'wrong' }, 'k')).status).toBe(401);
  });

  it('rejects a wrong key of the same length', async () => {
    expect((await request({ 'X-Admin-Key': 'kex' }, 'key')).status).toBe(401);
  });

  it('rejects an empty header before consulting the secret', async () => {
    expect((await request({ 'X-Admin-Key': '' }, 'k')).status).toBe(401);
  });

  it('fails closed when the secret is unset', async () => {
    // A non-empty header gets past the header check, so this exercises the
    // !storedKey guard rather than the missing-header branch.
    expect((await request({ 'X-Admin-Key': 'anything' }, undefined)).status).toBe(401);
  });

  it('fails closed when the secret is empty', async () => {
    expect((await request({ 'X-Admin-Key': 'anything' }, '')).status).toBe(401);
  });
});

describe('createErrorHandler', () => {
  it('converts an unhandled throw into the generic 500 envelope', async () => {
    const app = new Hono<HttpEnv>();
    app.onError(createErrorHandler('test-service'));
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });
});
