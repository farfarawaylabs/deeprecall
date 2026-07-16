/**
 * CloudflareApiClient with a mocked globalThis.fetch (the pool no longer
 * ships cloudflare:test's fetchMock, so a plain vi.spyOn is the boundary).
 *
 * Pins for every provisioning method: exact URL, HTTP verb, bearer-auth
 * headers, and JSON body - plus the error contract: failure is keyed
 * SOLELY on the envelope's `success` flag (the client implements no retry
 * and never inspects response.status), and error messages join every
 * envelope error as "[code] message".
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { CloudflareApiClient } from '../src/cloudflare-api';

const API_TOKEN = 'test-cf-token';
const ACCOUNT_ID = 'acct-123';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  fetchSpy.mockReset();
});

afterAll(() => {
  fetchSpy.mockRestore();
});

function makeClient(): CloudflareApiClient {
  return new CloudflareApiClient(API_TOKEN, ACCOUNT_ID);
}

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function cfFailure(errors: Array<{ code: number; message: string }>, status = 200): Response {
  return Response.json({ success: false, errors, messages: [], result: null }, { status });
}

/** The single fetch call's (url, init) pair, with the body JSON-parsed. */
function sentRequest() {
  expect(fetchSpy).toHaveBeenCalledOnce();
  const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
  };
}

describe('request construction', () => {
  it('createD1Database POSTs the name with bearer auth and returns the result', async () => {
    fetchSpy.mockResolvedValue(cfSuccess({ uuid: 'd1-uuid-1', name: 'deeprecall-db-acme' }));

    const result = await makeClient().createD1Database('deeprecall-db-acme');

    expect(result).toEqual({ uuid: 'd1-uuid-1', name: 'deeprecall-db-acme' });
    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/d1/database`);
    expect(sent.method).toBe('POST');
    expect(sent.headers).toEqual({
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(sent.body).toEqual({ name: 'deeprecall-db-acme' });
  });

  it('createVectorizeIndex nests dimensions and metric under config', async () => {
    fetchSpy.mockResolvedValue(cfSuccess({ name: 'deeprecall-vec-acme' }));

    const result = await makeClient().createVectorizeIndex('deeprecall-vec-acme', 768, 'cosine');

    expect(result).toEqual({ name: 'deeprecall-vec-acme' });
    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/vectorize/v2/indexes`);
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({
      name: 'deeprecall-vec-acme',
      config: { dimensions: 768, metric: 'cosine' },
    });
  });

  it('createVectorizeMetadataIndex targets the index and maps type to indexType', async () => {
    fetchSpy.mockResolvedValue(cfSuccess({ mutationId: 'mut-1' }));

    const result = await makeClient().createVectorizeMetadataIndex(
      'deeprecall-vec-acme',
      'user_id',
      'string',
    );

    expect(result).toEqual({ mutationId: 'mut-1' });
    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/vectorize/v2/indexes/deeprecall-vec-acme/metadata_index/create`);
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({ propertyName: 'user_id', indexType: 'string' });
  });

  it('deleteD1Database sends a body-less DELETE and resolves void', async () => {
    fetchSpy.mockResolvedValue(cfSuccess(null));

    await expect(makeClient().deleteD1Database('d1-uuid-1')).resolves.toBeUndefined();

    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/d1/database/d1-uuid-1`);
    expect(sent.method).toBe('DELETE');
    expect(sent.body).toBeUndefined();
  });

  it('deleteVectorizeIndex sends a body-less DELETE by index name', async () => {
    fetchSpy.mockResolvedValue(cfSuccess(null));

    await expect(makeClient().deleteVectorizeIndex('deeprecall-vec-acme')).resolves.toBeUndefined();

    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/vectorize/v2/indexes/deeprecall-vec-acme`);
    expect(sent.method).toBe('DELETE');
    expect(sent.body).toBeUndefined();
  });

  it('executeD1Sql POSTs the sql string to the query endpoint', async () => {
    fetchSpy.mockResolvedValue(cfSuccess([{ results: [] }]));

    const result = await makeClient().executeD1Sql('d1-uuid-1', 'SELECT 1');

    expect(result).toEqual([{ results: [] }]);
    const sent = sentRequest();
    expect(sent.url).toBe(`${BASE}/d1/database/d1-uuid-1/query`);
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({ sql: 'SELECT 1' });
  });
});

describe('error surfacing', () => {
  it('throws with every envelope error joined as "[code] message"', async () => {
    fetchSpy.mockResolvedValue(
      cfFailure([
        { code: 7003, message: 'no such database' },
        { code: 10000, message: 'authentication error' },
      ]),
    );

    await expect(makeClient().createD1Database('x')).rejects.toThrow(
      'Cloudflare API error: [7003] no such database; [10000] authentication error',
    );
  });

  it('keys failure on the success flag, not the HTTP status', async () => {
    // A 403 with a well-formed failure envelope surfaces the envelope error;
    // the client never reads response.status (no retry, no status branch).
    fetchSpy.mockResolvedValue(cfFailure([{ code: 9109, message: 'Unauthorized' }], 403));

    await expect(makeClient().deleteVectorizeIndex('vec')).rejects.toThrow(
      'Cloudflare API error: [9109] Unauthorized',
    );
  });

  it('a non-JSON response body rejects with the parse failure', async () => {
    // Pinned current behavior: the client parses the body unconditionally,
    // so a gateway error page (HTML 502) surfaces as a JSON parse error
    // rather than a shaped "Cloudflare API error". Callers only get the
    // reject; the message is unactionable but the failure is not swallowed.
    fetchSpy.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(makeClient().createD1Database('x')).rejects.toThrow(SyntaxError);
  });
});
