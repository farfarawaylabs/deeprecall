import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('memory-api worker', () => {
  it('responds on root without auth', async () => {
    const response = await SELF.fetch('http://localhost/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body).toEqual({ status: 'ok', service: 'memory-api' });
  });

  it('health check is accessible without API key', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');
    expect(response.status).toBe(200);
  });

  it('returns 401 on /v1/ingest without API key', async () => {
    const response = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });
});
