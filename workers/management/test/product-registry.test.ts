/**
 * Product registry over REAL miniflare KV (the CONFIG binding from
 * vitest.config.mts). Pins the KV key layout ("product:<id>:config"), the
 * malformed-entry policy (treated as not-found / skipped, never thrown),
 * and the list filter that keeps sibling keys (api_key, api_key_hash,
 * apikey:<hash> index entries) out of the results.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProductConfig,
  listAllProductConfigs,
  type ProductConfig,
} from '../src/product-registry';

function makeConfig(productId: string, overrides: Partial<ProductConfig> = {}): ProductConfig {
  return {
    product_id: productId,
    name: `Product ${productId}`,
    policy_overrides: {},
    features: { document_ingestion: true },
    db_id: `db-id-${productId}`,
    db_name: `deeprecall-db-${productId}`,
    vectorize_name: `deeprecall-vec-${productId}`,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seedConfig(config: ProductConfig): Promise<void> {
  await env.CONFIG.put(`product:${config.product_id}:config`, JSON.stringify(config));
}

// Storage isolation is per test FILE, so clear KV between tests inline
// (same pattern as migrate-key-index.test.ts).
beforeEach(async () => {
  const list = await env.CONFIG.list();
  for (const k of list.keys) await env.CONFIG.delete(k.name);
});

describe('getProductConfig', () => {
  it('returns null for an unregistered product', async () => {
    expect(await getProductConfig(env.CONFIG, 'ghost')).toBeNull();
  });

  it('returns the parsed config for a registered product', async () => {
    const config = makeConfig('acme', { answer_model: 'anthropic:claude-sonnet-4-5' });
    await seedConfig(config);

    expect(await getProductConfig(env.CONFIG, 'acme')).toEqual(config);
  });

  it('reads exactly the product:<id>:config key, not sibling keys', async () => {
    await seedConfig(makeConfig('acme'));
    await env.CONFIG.put('product:acme:api_key', 'sk-plain');
    await env.CONFIG.put('product:acme-2:config', JSON.stringify(makeConfig('acme-2')));

    const config = await getProductConfig(env.CONFIG, 'acme');
    expect(config?.product_id).toBe('acme');
  });

  it('treats a malformed stored config as not found (null, no throw)', async () => {
    await env.CONFIG.put('product:broken:config', '{not json');

    expect(await getProductConfig(env.CONFIG, 'broken')).toBeNull();
  });
});

describe('listAllProductConfigs', () => {
  it('returns an empty array when no products are registered', async () => {
    expect(await listAllProductConfigs(env.CONFIG)).toEqual([]);
  });

  it('returns every registered config and ignores non-config keys', async () => {
    await seedConfig(makeConfig('alpha'));
    await seedConfig(makeConfig('beta'));
    // Sibling and unrelated keys that share the "product:" prefix or live
    // alongside it - none may leak into the result.
    await env.CONFIG.put('product:alpha:api_key', 'sk-plain');
    await env.CONFIG.put('product:alpha:api_key_hash', 'abc123');
    await env.CONFIG.put('apikey:abc123', 'alpha');
    await env.CONFIG.put('purge_job:alpha:job-1', '{}');

    const configs = await listAllProductConfigs(env.CONFIG);
    expect(configs.map((c) => c.product_id).sort()).toEqual(['alpha', 'beta']);
  });

  it('skips malformed config entries while keeping valid ones', async () => {
    await seedConfig(makeConfig('good'));
    await env.CONFIG.put('product:bad:config', '<<<definitely not json>>>');

    const configs = await listAllProductConfigs(env.CONFIG);
    expect(configs.map((c) => c.product_id)).toEqual(['good']);
  });

  it('round-trips optional fields like answer_model', async () => {
    await seedConfig(makeConfig('with-model', { answer_model: 'google:gemini-2.5-pro' }));
    await seedConfig(makeConfig('without-model'));

    const configs = await listAllProductConfigs(env.CONFIG);
    const withModel = configs.find((c) => c.product_id === 'with-model');
    const withoutModel = configs.find((c) => c.product_id === 'without-model');
    expect(withModel?.answer_model).toBe('google:gemini-2.5-pro');
    expect(withoutModel?.answer_model).toBeUndefined();
  });
});
