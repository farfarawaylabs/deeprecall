import type { LogContext, AxiomConfig } from '@deeprecall/logger';

/**
 * Minimal structural Hono env the shared middleware needs. Each worker's own
 * AppBindings satisfies this (extra bindings/variables are fine), so the
 * factories below can be reused without importing worker-specific types.
 */
export type HttpEnv = {
  Bindings: {
    ADMIN_KEY?: string;
    AXIOM_API_TOKEN?: string;
    AXIOM_DATASET?: string;
  };
  Variables: {
    trace_id: string;
    log_ctx: LogContext;
    axiom_config: AxiomConfig | undefined;
  };
};
