// Augment the auto-generated Env with secrets (not in wrangler.jsonc).
declare global {
  interface Env {
    AXIOM_API_TOKEN: string;
    AXIOM_DATASET: string;
    /** Shared secret verifying the caller is memory-api (via service binding). */
    INTERNAL_SERVICE_KEY?: string;
  }
}

export {};
