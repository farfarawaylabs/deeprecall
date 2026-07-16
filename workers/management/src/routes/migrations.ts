import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { ManagementRequestError } from '../errors';
import { managementContext } from '../context';
import { getMigrationsStatus, migrateAllProducts } from '../migrations/migrations-service';

const migrations = new Hono<AppBindings>();

/**
 * GET /migrations/status
 * Check schema versions across all registered products.
 */
migrations.get('/status', async (c) => {
  try {
    const result = await getMigrationsStatus(managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * POST /migrations/migrate-all
 * Run pending migrations across all registered product databases.
 */
migrations.post('/migrate-all', async (c) => {
  try {
    const result = await migrateAllProducts(managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

export { migrations };
