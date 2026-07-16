import type { ErrorHandler } from 'hono';
import { Logger } from '@deeprecall/logger';
import { apiError } from './api-error';
import type { HttpEnv } from './types';

/**
 * Global error handler that returns the standard ApiError envelope.
 * Uses structured Logger for consistent Axiom-shipped error logs.
 */
export function createErrorHandler<E extends HttpEnv>(serviceName: string): ErrorHandler<E> {
  return (err, c) => {
    const ctx = c.get('log_ctx');

    if (ctx) {
      Logger.error(ctx, 'Unhandled error', {
        error: err.message,
        path: c.req.path,
        method: c.req.method,
      });
    } else {
      // Fallback if logging middleware hasn't run (e.g., middleware-level crash)
      console.error(
        JSON.stringify({
          level: 'error',
          service: serviceName,
          message: 'Unhandled error',
          error: err.message,
          path: c.req.path,
          method: c.req.method,
        }),
      );
    }

    return apiError(c, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  };
}
