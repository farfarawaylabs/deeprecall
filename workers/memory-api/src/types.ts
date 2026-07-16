import type { LogContext, AxiomConfig } from '@deeprecall/logger';

/** Hono app type with Cloudflare Workers bindings and custom variables. */
export type AppBindings = {
  Bindings: Env;
  Variables: {
    product_id: string;
    trace_id: string;
    log_ctx: LogContext;
    axiom_config: AxiomConfig | undefined;
  };
};
