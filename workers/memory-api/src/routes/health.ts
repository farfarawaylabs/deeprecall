import { Hono } from 'hono';
import type { AppBindings } from '../types';

const health = new Hono<AppBindings>();

/**
 * GET /v1/health
 * Basic health check — pings D1 and Vectorize via the DATA service binding.
 */
health.get('/', async (c) => {
  const checks: Record<string, 'ok' | 'error'> = {};

  // Check D1 via DATA service (a getById for a non-existent id exercises the D1 connection)
  try {
    await c.env.DATA.memoryGetById('default', 'nonexistent');
    checks.d1 = 'ok';
  } catch {
    checks.d1 = 'error';
  }

  // Check Vectorize via DATA service (search with a zero vector exercises the index)
  try {
    await c.env.DATA.vectorSearch('default', new Array(1024).fill(0), {}, 1);
    checks.vectorize = 'ok';
  } catch {
    checks.vectorize = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  const anyError = Object.values(checks).some((v) => v === 'error');

  return c.json({
    status: allOk ? 'ok' : anyError ? 'degraded' : 'ok',
    service: 'memory-api',
    timestamp: new Date().toISOString(),
    checks,
  });
});

export { health };
