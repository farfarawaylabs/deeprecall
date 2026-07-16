import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('management worker', () => {
  it('responds with health status', async () => {
    const response = await SELF.fetch('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok', service: 'management' });
  });
});
