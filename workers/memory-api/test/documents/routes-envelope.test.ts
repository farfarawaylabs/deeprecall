import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { sha256Hex } from '@deeprecall/http';

// Route-level tests pinning the HTTP error envelope produced from typed BL
// errors (DocumentRequestError / CorrectionRequestError): status mapping,
// {error:{code,message}} shape, and the conditional `details` passthrough.
// These paths fail validation BEFORE any DATA/INGESTION call, so they run
// against the real worker with only the miniflare CONFIG KV bound.

const API_KEY = 'envelope-test-key-0123456789abcdef';

beforeAll(async () => {
  const hash = await sha256Hex(API_KEY);
  await env.CONFIG.put(`apikey:${hash}`, 'p_envelope');
});

function multipart(fields: Record<string, string | File>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe('documents route error envelope', () => {
  it('shapes scope validation failures as 400 with details attached', async () => {
    const res = await SELF.fetch('http://localhost/v1/documents', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      body: multipart({
        file: new File(['hello'], 'a.txt', { type: 'text/plain' }),
        scope: '{}', // valid JSON, fails the Scope schema
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid scope');
    expect(body.error.details).toBeDefined();
  });

  it('shapes unsupported uploads as 422 WITHOUT a details key', async () => {
    const res = await SELF.fetch('http://localhost/v1/documents', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      body: multipart({
        file: new File(['x'], 'a.png', { type: 'image/png' }),
        scope: JSON.stringify({ user_id: 'u1' }),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe('UNSUPPORTED_CONTENT');
    expect('details' in body.error).toBe(false);
  });

  it('shapes missing-file uploads as 400 VALIDATION_ERROR', async () => {
    const res = await SELF.fetch('http://localhost/v1/documents', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      body: multipart({ scope: JSON.stringify({ user_id: 'u1' }) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe("Missing or invalid 'file' field. Must be a file upload.");
  });
});

describe('correct route error envelope', () => {
  it('shapes body validation failures as 400 with details attached', async () => {
    const res = await SELF.fetch('http://localhost/v1/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ action: 'suppress' }), // missing memory_id + scope
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid correction request');
    expect(body.error.details).toBeDefined();
  });
});
