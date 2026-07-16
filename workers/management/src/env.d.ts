// Augment the auto-generated Env with secrets (not in wrangler.jsonc)
declare global {
  interface Env {
    CLOUDFLARE_API_TOKEN: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    AXIOM_API_TOKEN: string;
    AXIOM_DATASET: string;
  }
}

export {};
