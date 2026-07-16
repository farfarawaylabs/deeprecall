// Augment the auto-generated Env with secrets and optional Claude-runtime
// vars (secrets are not in wrangler.jsonc, so `wrangler types` misses them).
declare global {
  interface Env {
    /** Claude runtime: "bedrock" (default) or "anthropic". Set in wrangler vars. */
    ANTHROPIC_PROVIDER?: string;
    /** AWS credentials for the Bedrock runtime. Region is a wrangler var; keys are secrets. */
    AWS_REGION?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_SESSION_TOKEN?: string;
  }
}

export {};
