import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('consolidation worker', () => {
  it('responds with health status at /health', async () => {
    const response = await SELF.fetch('http://localhost/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok', service: 'consolidation' });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await SELF.fetch('http://localhost/');
    expect(response.status).toBe(404);
  });
});
