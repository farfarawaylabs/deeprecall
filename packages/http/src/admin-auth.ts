import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from './crypto';
import { apiError } from './api-error';
import type { HttpEnv } from './types';

/**
 * Admin authentication middleware.
 * Reads X-Admin-Key header, validates against the ADMIN_KEY worker secret.
 * Fails closed when the secret is unset.
 */
export function createAdminKeyAuth<E extends HttpEnv>() {
  return createMiddleware<E>(async (c, next) => {
    const adminKey = c.req.header('x-admin-key');
    if (!adminKey) {
      return apiError(c, 401, 'AUTHENTICATION_ERROR', 'Missing X-Admin-Key header');
    }

    const storedKey = c.env.ADMIN_KEY;
    if (!storedKey || !timingSafeEqual(storedKey, adminKey)) {
      return apiError(c, 401, 'AUTHENTICATION_ERROR', 'Invalid admin key');
    }

    // trace_id already set by logging middleware
    await next();
  });
}
