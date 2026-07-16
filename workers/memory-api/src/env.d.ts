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
    /** Optional — required only when an OpenAI model is selected for /v1/answer */
    OPENAI_API_KEY?: string;
    /** Optional — required only when a Google model is selected for /v1/answer */
    GOOGLE_API_KEY?: string;
    /** Default answer model spec, e.g. "anthropic:claude-opus-4-8" (var) */
    ANSWER_MODEL?: string;
    AXIOM_API_TOKEN: string;
    AXIOM_DATASET: string;
    /** Shared secret attached to ingestion/retrieval service-binding calls. */
    INTERNAL_SERVICE_KEY?: string;
  }
}

export {};
