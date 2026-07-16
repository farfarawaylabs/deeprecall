import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { INITIAL_SCHEMA_SQL } from '@deeprecall/db';
import {
  decommissionProduct,
  onboardProduct,
  REQUIRED_METADATA_INDEXES,
  type OnboardInput,
} from '../../src/provisioning/provisioning-service';
import type { CloudflareApi, ManagementContext } from '../../src/context';
import { ManagementRequestError } from '../../src/errors';

// ─── Fakes ───────────────────────────────────────────────────

interface Call {
  method: string;
  args: unknown[];
}

function fakeCfApi(
  opts: {
    failD1Create?: boolean;
    failVectorize?: boolean;
    failMetadataProps?: string[];
    failSchemaSql?: boolean;
    failDeleteD1?: boolean;
    failDeleteVectorize?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const api: CloudflareApi & { calls: Call[] } = {
    calls,
    async createD1Database(name: string) {
      calls.push({ method: 'createD1Database', args: [name] });
      if (opts.failD1Create) throw new Error('d1 create boom');
      return { uuid: 'db-uuid-new', name };
    },
    async createVectorizeIndex(name: string, dimensions: number, metric: string) {
      calls.push({ method: 'createVectorizeIndex', args: [name, dimensions, metric] });
      if (opts.failVectorize) throw new Error('vectorize boom');
      return { name };
    },
    async createVectorizeMetadataIndex(indexName: string, propertyName: string, type: string) {
      calls.push({ method: 'createVectorizeMetadataIndex', args: [indexName, propertyName, type] });
      if (opts.failMetadataProps?.includes(propertyName)) {
        throw new Error(`metadata boom: ${propertyName}`);
      }
      return {};
    },
    async deleteD1Database(databaseId: string) {
      calls.push({ method: 'deleteD1Database', args: [databaseId] });
      if (opts.failDeleteD1) throw new Error('d1 delete boom');
    },
    async deleteVectorizeIndex(indexName: string) {
      calls.push({ method: 'deleteVectorizeIndex', args: [indexName] });
      if (opts.failDeleteVectorize) throw new Error('vectorize delete boom');
    },
    async executeD1Sql(databaseId: string, sql: string) {
      calls.push({ method: 'executeD1Sql', args: [databaseId, sql] });
      if (opts.failSchemaSql) throw new Error('sql boom');
      return [];
    },
  };
  return api;
}

function fakeDataService(opts: { failR2?: boolean } = {}) {
  return {
    async documentDeleteByPrefix(prefix: string) {
      if (opts.failR2) throw new Error('r2 boom');
      void prefix;
      return 7;
    },
  };
}

function ctxWith(overrides: Partial<Record<string, unknown>> = {}): ManagementContext {
  const testEnv = {
    CONFIG: env.CONFIG,
    CLOUDFLARE_API_TOKEN: 'test-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    ENVIRONMENT: 'dev',
    DATA: fakeDataService(),
    ...overrides,
  };
  return { env: testEnv as unknown as Env, logCtx: undefined };
}

function onboardInput(overrides: Partial<OnboardInput> = {}): OnboardInput {
  return {
    product_id: 'new-product',
    name: 'New Product',
    policy_overrides: {},
    features: {},
    ...overrides,
  };
}

async function kvKeys(): Promise<string[]> {
  const list = await env.CONFIG.list();
  return list.keys.map((k) => k.name).sort();
}

beforeEach(async () => {
  const list = await env.CONFIG.list();
  for (const k of list.keys) await env.CONFIG.delete(k.name);
});

// ─── Onboard ─────────────────────────────────────────────────

describe('onboardProduct', () => {
  it('provisions D1, Vectorize, 6 metadata indexes, applies the schema, and registers KV last', async () => {
    const cfApi = fakeCfApi();
    const result = await onboardProduct(onboardInput(), ctxWith(), () => cfApi);

    // Resource creation with env-suffixed names.
    expect(cfApi.calls[0]).toEqual({
      method: 'createD1Database',
      args: ['deeprecall-db-new-product-dev'],
    });
    expect(cfApi.calls[1]).toEqual({
      method: 'createVectorizeIndex',
      args: ['deeprecall-vectors-new-product-dev', 1024, 'cosine'],
    });
    const metadataCalls = cfApi.calls.filter((c) => c.method === 'createVectorizeMetadataIndex');
    expect(metadataCalls.map((c) => c.args[1]).sort()).toEqual(
      REQUIRED_METADATA_INDEXES.map((i) => i.propertyName).sort(),
    );
    // Baseline schema applied over the REST API — the canonical constant.
    const sqlCall = cfApi.calls.find((c) => c.method === 'executeD1Sql')!;
    expect(sqlCall.args).toEqual(['db-uuid-new', INITIAL_SCHEMA_SQL]);

    // Response body.
    expect(result.product_id).toBe('new-product');
    expect(result.db_id).toBe('db-uuid-new');
    expect(result.db_name).toBe('deeprecall-db-new-product-dev');
    expect(result.vectorize_name).toBe('deeprecall-vectors-new-product-dev');
    expect(result.api_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.migration_warning).toBeUndefined();
    expect(result.message).toBe(
      'Product onboarded (D1, Vectorize index, and 6 metadata indexes provisioned). Add the wrangler snippet to workers/data/wrangler.jsonc and redeploy.',
    );
    expect(result.wrangler_snippet).toEqual({
      d1_databases: [
        {
          binding: 'DB_new-product',
          database_name: 'deeprecall-db-new-product-dev',
          database_id: 'db-uuid-new',
        },
      ],
      vectorize: [{ binding: 'VEC_new-product', index_name: 'deeprecall-vectors-new-product-dev' }],
    });

    // KV registration: hashed auth index + bookkeeping + bindings + config.
    const keys = await kvKeys();
    expect(keys).toHaveLength(5);
    expect(keys).toContain('product:new-product:api_key_hash');
    expect(keys).toContain('product:new-product:db_binding');
    expect(keys).toContain('product:new-product:vec_binding');
    expect(keys).toContain('product:new-product:config');
    const hash = await env.CONFIG.get('product:new-product:api_key_hash');
    expect(await env.CONFIG.get(`apikey:${hash}`)).toBe('new-product');
    // No plaintext key anywhere in KV.
    expect(keys.some((k) => k.endsWith(':api_key'))).toBe(false);
  });

  it('fails without rollback when D1 creation fails (nothing to clean up)', async () => {
    const cfApi = fakeCfApi({ failD1Create: true });
    const err = await onboardProduct(onboardInput(), ctxWith(), () => cfApi).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ManagementRequestError);
    expect((err as ManagementRequestError).code).toBe('PROVISIONING_ERROR');
    expect((err as ManagementRequestError).message).toBe(
      'Failed to create D1 database for product',
    );
    expect(cfApi.calls.map((c) => c.method)).toEqual(['createD1Database']);
    expect(await kvKeys()).toEqual([]);
  });

  it('rolls back the D1 database when Vectorize creation fails', async () => {
    const cfApi = fakeCfApi({ failVectorize: true });
    const err = await onboardProduct(onboardInput(), ctxWith(), () => cfApi).catch(
      (e: unknown) => e,
    );
    expect((err as ManagementRequestError).message).toBe(
      'Failed to create Vectorize index for product',
    );
    const methods = cfApi.calls.map((c) => c.method);
    expect(methods).toContain('deleteD1Database');
    expect(methods).not.toContain('deleteVectorizeIndex');
    expect(await kvKeys()).toEqual([]);
  });

  it('rolls back BOTH resources when metadata index creation fails, reporting which properties failed', async () => {
    const cfApi = fakeCfApi({ failMetadataProps: ['status', 'confidence'] });
    const err = await onboardProduct(onboardInput(), ctxWith(), () => cfApi).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ManagementRequestError);
    const mre = err as ManagementRequestError;
    expect(mre.code).toBe('PROVISIONING_METADATA_INDEX_ERROR');
    expect(mre.details).toEqual({ failed_properties: ['status', 'confidence'] });

    const methods = cfApi.calls.map((c) => c.method);
    expect(methods).toContain('deleteVectorizeIndex');
    expect(methods).toContain('deleteD1Database');
    expect(await kvKeys()).toEqual([]);
  });

  it('still onboards (with a warning) when the schema migration fails', async () => {
    const cfApi = fakeCfApi({ failSchemaSql: true });
    const result = await onboardProduct(onboardInput(), ctxWith(), () => cfApi);
    expect(result.migration_warning).toContain('Schema migration failed');
    expect(result.message).toContain('schema migration failed');
    // Registration still happened — migration is retriable.
    expect(await kvKeys()).toHaveLength(5);
    // And no rollback was triggered.
    expect(cfApi.calls.map((c) => c.method)).not.toContain('deleteD1Database');
  });

  it('rejects an invalid ENVIRONMENT before creating anything', async () => {
    const cfApi = fakeCfApi();
    const err = await onboardProduct(
      onboardInput(),
      ctxWith({ ENVIRONMENT: 'staging' }),
      () => cfApi,
    ).catch((e: unknown) => e);
    expect((err as ManagementRequestError).code).toBe('CONFIGURATION_ERROR');
    expect((err as ManagementRequestError).message).toBe(
      "ENVIRONMENT var must be set to 'dev' or 'prod' in wrangler.jsonc",
    );
    expect(cfApi.calls).toEqual([]);
  });
});

// ─── Decommission ────────────────────────────────────────────

async function seedFullProduct(productId: string): Promise<void> {
  await env.CONFIG.put(
    `product:${productId}:config`,
    JSON.stringify({
      product_id: productId,
      name: 'Seeded',
      policy_overrides: {},
      features: {},
      db_id: 'db-uuid-old',
      db_name: `deeprecall-db-${productId}-dev`,
      vectorize_name: `deeprecall-vectors-${productId}-dev`,
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  );
  await env.CONFIG.put(`product:${productId}:api_key_hash`, 'somehash');
  await env.CONFIG.put(`apikey:somehash`, productId);
  await env.CONFIG.put(`product:${productId}:db_binding`, `DB_${productId}`);
  await env.CONFIG.put(`product:${productId}:vec_binding`, `VEC_${productId}`);
  await env.CONFIG.put(`template:${productId}:conversation`, 'tpl-1');
  await env.CONFIG.put(`template:${productId}:document`, 'tpl-2');
}

describe('decommissionProduct', () => {
  it('deletes R2 docs, Vectorize, D1, and every KV entry including templates and the auth index', async () => {
    await seedFullProduct('old-product');
    const cfApi = fakeCfApi();
    const result = await decommissionProduct('old-product', ctxWith(), () => cfApi);

    expect(result.status).toBe('deleted');
    expect(result.results.r2_documents).toEqual({ status: 'deleted', count: 7 });
    expect(result.results.vectorize_index).toEqual({ status: 'deleted' });
    expect(result.results.d1_database).toEqual({ status: 'deleted' });
    expect(result.retry_note).toBeUndefined();
    expect(result.manual_steps).toEqual([
      'Remove the DB_old-product and VEC_old-product bindings from workers/data/wrangler.jsonc',
      'Redeploy the data worker: pnpm deploy:dev:data (or deploy:prod:data)',
    ]);

    expect(cfApi.calls).toEqual([
      { method: 'deleteVectorizeIndex', args: ['deeprecall-vectors-old-product-dev'] },
      { method: 'deleteD1Database', args: ['db-uuid-old'] },
    ]);

    expect(await kvKeys()).toEqual([]);
  });

  it('preserves the config key (and only it) when infrastructure deletion fails', async () => {
    await seedFullProduct('old-product');
    const cfApi = fakeCfApi({ failDeleteVectorize: true });
    const result = await decommissionProduct('old-product', ctxWith(), () => cfApi);

    expect(result.status).toBe('partial_failure');
    expect(result.results.vectorize_index).toEqual({
      status: 'failed',
      error: 'Failed to delete Vectorize index',
    });
    expect(result.retry_note).toBe(
      'Some resources failed to delete. The product config was preserved so you can retry this operation.',
    );
    // Config survives for the retry; everything else is gone.
    expect(await kvKeys()).toEqual(['product:old-product:config']);
  });

  it('marks R2 cleanup failed but continues with the other resources', async () => {
    await seedFullProduct('old-product');
    const cfApi = fakeCfApi();
    const result = await decommissionProduct(
      'old-product',
      ctxWith({ DATA: fakeDataService({ failR2: true }) }),
      () => cfApi,
    );

    expect(result.results.r2_documents).toEqual({
      status: 'failed',
      error: 'Failed to delete R2 documents',
    });
    // Vectorize + D1 still deleted despite the R2 failure.
    expect(result.results.vectorize_index).toEqual({ status: 'deleted' });
    expect(result.results.d1_database).toEqual({ status: 'deleted' });
    expect(result.status).toBe('partial_failure');
    expect(await kvKeys()).toEqual(['product:old-product:config']);
  });

  it('throws NOT_FOUND for an unregistered product', async () => {
    const err = await decommissionProduct('ghost', ctxWith(), () => fakeCfApi()).catch(
      (e: unknown) => e,
    );
    expect((err as ManagementRequestError).code).toBe('NOT_FOUND');
    expect((err as ManagementRequestError).status).toBe(404);
  });

  it('throws INTERNAL_ERROR for malformed config JSON', async () => {
    await env.CONFIG.put('product:broken:config', '{not json');
    const err = await decommissionProduct('broken', ctxWith(), () => fakeCfApi()).catch(
      (e: unknown) => e,
    );
    expect((err as ManagementRequestError).code).toBe('INTERNAL_ERROR');
    expect((err as ManagementRequestError).message).toBe("Invalid config for product 'broken'");
  });
});
