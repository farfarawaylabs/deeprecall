/**
 * Shared product config types and KV listing utility.
 * Used by both products.ts and migrations.ts routes.
 */

export interface ProductConfig {
  product_id: string;
  name: string;
  policy_overrides: Record<string, unknown>;
  features: Record<string, unknown>;
  /** Optional per-product answer model spec `<provider>:<model-id>` for /v1/answer.
   * When absent, memory-api falls back to its ANSWER_MODEL env var / default. */
  answer_model?: string;
  db_id: string;
  db_name: string;
  vectorize_name: string;
  created_at: string;
}

/**
 * Load a single product's config from KV by product ID.
 * Returns null if the product is not registered or its config is malformed
 * (malformed entries are treated as "not found" — callers surface a 404).
 */
export async function getProductConfig(
  kv: KVNamespace,
  productId: string,
): Promise<ProductConfig | null> {
  const configStr = await kv.get(`product:${productId}:config`);
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as ProductConfig;
  } catch {
    return null;
  }
}

/**
 * List all registered product configs from KV.
 * Iterates KV keys with prefix "product:" and filters for ":config" suffix.
 */
export async function listAllProductConfigs(kv: KVNamespace): Promise<ProductConfig[]> {
  const configs: ProductConfig[] = [];
  let cursor: string | undefined;
  let done = false;

  while (!done) {
    const listResult = await kv.list({
      prefix: 'product:',
      cursor,
    });

    for (const key of listResult.keys) {
      if (key.name.endsWith(':config')) {
        const configStr = await kv.get(key.name);
        if (configStr) {
          try {
            configs.push(JSON.parse(configStr) as ProductConfig);
          } catch {
            // Skip invalid entries
          }
        }
      }
    }

    if (listResult.list_complete) {
      done = true;
    } else {
      cursor = listResult.cursor;
    }
  }

  return configs;
}
