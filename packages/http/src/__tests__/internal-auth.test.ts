import { describe, it, expect, vi } from 'vitest';
import { verifyInternalKey, internalFetch } from '../internal-auth';

const req = (headers: Record<string, string> = {}) =>
  new Request('https://internal/x', { headers });

describe('verifyInternalKey', () => {
  it('fails closed with a tagged 500 when no key is configured', async () => {
    const res = verifyInternalKey(req({ 'X-Internal-Key': 'anything' }), undefined);
    expect(res?.status).toBe(500);
    expect(res?.headers.get('X-Internal-Auth-Failure')).toBe('1');
    const body = (await res!.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_MISCONFIGURED');
  });

  it('rejects a missing header with a tagged 401', async () => {
    const res = verifyInternalKey(req(), 'expected-key');
    expect(res?.status).toBe(401);
    expect(res?.headers.get('X-Internal-Auth-Failure')).toBe('1');
  });

  it('rejects a wrong key', () => {
    expect(verifyInternalKey(req({ 'X-Internal-Key': 'wrong-keyXX' }), 'expected-key')).not.toBe(
      null,
    );
  });

  it('returns null (authorized) for the correct key', () => {
    expect(verifyInternalKey(req({ 'X-Internal-Key': 'expected-key' }), 'expected-key')).toBe(null);
  });
});

describe('internalFetch', () => {
  const makeBinding = (response: Response) => {
    const fetch = vi.fn().mockResolvedValue(response);
    return { binding: { fetch } as unknown as Fetcher, fetch };
  };

  it('attaches the X-Internal-Key header when a key is provided', async () => {
    const { binding, fetch } = makeBinding(Response.json({ ok: true }));
    await internalFetch(binding, new Request('https://internal/q'), 'k1');

    const sent = fetch.mock.calls[0][0] as Request;
    expect(sent.headers.get('X-Internal-Key')).toBe('k1');
  });

  it('sends no header when the key is unset (receiver fails closed)', async () => {
    const { binding, fetch } = makeBinding(Response.json({ ok: true }));
    await internalFetch(binding, new Request('https://internal/q'), undefined);

    const sent = fetch.mock.calls[0][0] as Request;
    expect(sent.headers.get('X-Internal-Key')).toBeNull();
  });

  it('masks tagged internal-auth failures behind a generic 502', async () => {
    const denial = Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'nope' } },
      { status: 401, headers: { 'X-Internal-Auth-Failure': '1' } },
    );
    const { binding } = makeBinding(denial);

    const res = await internalFetch(binding, new Request('https://internal/q'), 'k1');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'UPSTREAM_ERROR', message: 'Internal service call failed' });
  });

  it('passes through ordinary upstream responses untouched', async () => {
    const upstream = Response.json(
      { error: { code: 'VALIDATION_ERROR', message: 'bad' } },
      {
        status: 400,
      },
    );
    const { binding } = makeBinding(upstream);

    const res = await internalFetch(binding, new Request('https://internal/q'), 'k1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
