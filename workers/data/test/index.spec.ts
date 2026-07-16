import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('data worker fetch handler', () => {
  it('responds to /health with service metadata', async () => {
    const res = await SELF.fetch('http://localhost/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('data');
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
  });

  it('responds to / with the same health payload', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('data');
  });

  it('returns 404 for any other path', async () => {
    const res = await SELF.fetch('http://localhost/memories');
    expect(res.status).toBe(404);
  });
});
