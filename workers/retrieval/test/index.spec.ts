import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { verifyInternalKey } from '@deeprecall/http';

// Must match the INTERNAL_SERVICE_KEY injected via vitest.config.mts.
const INTERNAL_KEY = 'test-internal-key';
const authHeaders = (extra: Record<string, string> = {}) => ({
  'X-Internal-Key': INTERNAL_KEY,
  ...extra,
});

describe('retrieval worker', () => {
  it('rejects requests without the internal key (401)', async () => {
    const response = await SELF.fetch('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with a wrong internal key (401)', async () => {
    const response = await SELF.fetch('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': 'wrong' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(response.status).toBe(401);
  });

  it('returns 405 METHOD_NOT_ALLOWED for non-POST requests', async () => {
    const response = await SELF.fetch('http://localhost/', { headers: authHeaders() });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('returns 400 for missing required fields', async () => {
    const response = await SELF.fetch('http://localhost/', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ invalid: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('verifyInternalKey', () => {
  const req = (key?: string) =>
    new Request('http://internal/', { headers: key ? { 'x-internal-key': key } : {} });

  it('fails closed with 500 when the secret is not configured', () => {
    const denied = verifyInternalKey(req('anything'), undefined);
    expect(denied?.status).toBe(500);
    expect(denied?.headers.get('X-Internal-Auth-Failure')).toBe('1');
  });

  it('rejects a missing header with 401', () => {
    const denied = verifyInternalKey(req(), 'secret');
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get('X-Internal-Auth-Failure')).toBe('1');
  });

  it('rejects a wrong key with 401', () => {
    expect(verifyInternalKey(req('wrong'), 'secret')?.status).toBe(401);
  });

  it('authorizes a matching key (returns null)', () => {
    expect(verifyInternalKey(req('secret'), 'secret')).toBeNull();
  });
});
