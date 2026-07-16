// Augment the auto-generated Env with secrets (not in wrangler.jsonc)
declare global {
  interface Env {
    /** Required only when ANTHROPIC_PROVIDER is "anthropic". */
    ANTHROPIC_API_KEY?: string;
    /** Claude runtime: "bedrock" (default) or "anthropic". Set in wrangler vars. */
    ANTHROPIC_PROVIDER?: string;
    /** AWS credentials for the Bedrock runtime. Region is a wrangler var; keys are secrets. */
    AWS_REGION?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_SESSION_TOKEN?: string;
    AXIOM_API_TOKEN: string;
    AXIOM_DATASET: string;
    /** Shared secret verifying the caller is memory-api (via service binding). */
    INTERNAL_SERVICE_KEY?: string;
  }
}

export {};
