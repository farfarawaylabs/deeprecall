import { createMiddleware } from 'hono/factory';
import { Logger } from '@deeprecall/logger';
import type { AxiomConfig } from '@deeprecall/logger';
import type { HttpEnv } from './types';

/**
 * Logging middleware — creates a structured LogContext for each request,
 * stores it in Hono variables, and flushes to Axiom after the response.
 *
 * Must be applied before auth middleware so trace_id is available early.
 * Auth middleware should update the context with product_id/user_id.
 */
export function createLoggingMiddleware<E extends HttpEnv>(serviceName: string) {
  return createMiddleware<E>(async (c, next) => {
    const axiomConfig: AxiomConfig | undefined =
      c.env.AXIOM_API_TOKEN && c.env.AXIOM_DATASET
        ? { apiToken: c.env.AXIOM_API_TOKEN, dataset: c.env.AXIOM_DATASET }
        : undefined;

    const ctx = Logger.createContext(serviceName);
    c.set('log_ctx', ctx);
    c.set('axiom_config', axiomConfig);
    c.set('trace_id', ctx.trace_id);

    Logger.info(ctx, 'Request received', {
      method: c.req.method,
      path: c.req.path,
    });

    const start = Date.now();

    try {
      await next();
    } finally {
      Logger.info(ctx, 'Request completed', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Date.now() - start,
      });

      // Flush logs to Axiom in the background (non-blocking).
      // try/finally ensures flush happens even when the error handler fires.
      if (axiomConfig) {
        c.executionCtx.waitUntil(Logger.flush(ctx, axiomConfig));
      }
    }
  });
}
