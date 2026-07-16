import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMigrationsStatus,
  getProductMigrationStatus,
  migrateAllProducts,
} from '../../src/migrations/migrations-service';
import { SCHEMA_VERSION_SQL } from '@deeprecall/db';
import { ManagementRequestError } from '../../src/errors';
import type { CloudflareApi, ManagementContext } from '../../src/context';

/**
 * Fake CF API: version reads (SCHEMA_VERSION_SQL) answer per-db from
 * `versions` (or throw); any other SQL is treated as a migration step and
 * recorded, throwing when listed in `failSql`.
 */
function fakeCfApi(versions: Record<string, string | Error>, failSql: string[] = []) {
  const queries: string[] = [];
  const appliedSql: string[] = [];
  const api = {
    queries,
    appliedSql,
    async executeD1Sql(databaseId: string, sql: string) {
      queries.push(`${databaseId}: ${sql}`);
      if (sql === SCHEMA_VERSION_SQL) {
        const v = versions[databaseId];
        if (v instanceof Error) throw v;
        if (v === undefined) return [];
        return [{ results: [{ value: v }] }];
      }
      if (failSql.includes(sql)) throw new Error(`step boom: ${sql}`);
      appliedSql.push(sql);
      return [];
    },
  };
  return api as unknown as CloudflareApi & { queries: string[]; appliedSql: string[] };
}

function ctx(): ManagementContext {
  const testEnv = {
    CONFIG: env.CONFIG,
    CLOUDFLARE_API_TOKEN: 'test-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
  };
  return { env: testEnv as unknown as Env, logCtx: undefined };
}

async function seedConfig(productId: string, dbId: string): Promise<void> {
  await env.CONFIG.put(
    `product:${productId}:config`,
    JSON.stringify({
      product_id: productId,
      name: 'Seeded',
      policy_overrides: {},
      features: {},
      db_id: dbId,
      db_name: `deeprecall-db-${productId}-dev`,
      vectorize_name: `deeprecall-vectors-${productId}-dev`,
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  );
}

beforeEach(async () => {
  const list = await env.CONFIG.list();
  for (const k of list.keys) await env.CONFIG.delete(k.name);
});

describe('getMigrationsStatus', () => {
  it('reports all_current when every product is at the latest version', async () => {
    await seedConfig('prod-a', 'db-a');
    await seedConfig('prod-b', 'db-b');
    const result = await getMigrationsStatus(ctx(), () => fakeCfApi({ 'db-a': '4', 'db-b': '4' }));

    expect(result.status).toBe('all_current');
    expect(result.latest_schema_version).toBe('4');
    expect(result.total_products).toBe(2);
    expect(result.pending_migrations).toBe(0);
    expect(result.products.every((p) => p.up_to_date)).toBe(true);
  });

  it('flags version-read failures per product without failing the endpoint', async () => {
    await seedConfig('prod-a', 'db-a');
    await seedConfig('prod-b', 'db-b');
    const result = await getMigrationsStatus(ctx(), () =>
      fakeCfApi({ 'db-a': '4', 'db-b': new Error('api boom') }),
    );

    expect(result.status).toBe('migrations_pending');
    expect(result.pending_migrations).toBe(1);
    const broken = result.products.find((p) => p.product_id === 'prod-b')!;
    expect(broken.current_schema_version).toBeNull();
    expect(broken.up_to_date).toBe(false);
    expect(broken.error).toBe('Failed to query schema version');
  });

  it('treats a missing schema_version row as unknown (null, not up to date)', async () => {
    await seedConfig('prod-a', 'db-a');
    const result = await getMigrationsStatus(ctx(), () => fakeCfApi({}));
    expect(result.products[0]!.current_schema_version).toBeNull();
    expect(result.products[0]!.up_to_date).toBe(false);
  });
});

describe('migrateAllProducts', () => {
  it('returns no_products for an empty registry', async () => {
    const result = await migrateAllProducts(ctx(), () => fakeCfApi({}));
    expect(result).toEqual({
      status: 'no_products',
      message: 'No registered products found in KV',
      results: [],
    });
  });

  it('reports up_to_date products without applying anything', async () => {
    await seedConfig('prod-a', 'db-a');
    const cfApi = fakeCfApi({ 'db-a': '4' });
    const result = await migrateAllProducts(ctx(), () => cfApi);

    expect(result.status).toBe('success');
    expect(result.up_to_date).toBe(1);
    expect(result.results[0]).toEqual({
      product_id: 'prod-a',
      db_name: 'deeprecall-db-prod-a-dev',
      previous_version: '4',
      new_version: '4',
      status: 'up_to_date',
      migrations_applied: [],
    });
    // Only the single version read — no migration SQL was sent.
    expect(cfApi.queries).toHaveLength(1);
  });

  it('records an error result when the version read fails, and continues to other products', async () => {
    await seedConfig('prod-a', 'db-a');
    await seedConfig('prod-b', 'db-b');
    const result = await migrateAllProducts(ctx(), () =>
      fakeCfApi({ 'db-a': new Error('api boom'), 'db-b': '4' }),
    );

    expect(result.status).toBe('partial_failure');
    expect(result.errors).toBe(1);
    expect(result.results.find((r) => r.product_id === 'prod-a')).toEqual({
      product_id: 'prod-a',
      db_name: 'deeprecall-db-prod-a-dev',
      previous_version: null,
      new_version: null,
      status: 'error',
      migrations_applied: [],
      error: 'Failed to read schema version',
    });
    expect(result.results.find((r) => r.product_id === 'prod-b')!.status).toBe('up_to_date');
  });

  it('applies pending steps in ascending order with injected steps', async () => {
    await seedConfig('prod-a', 'db-a');
    const cfApi = fakeCfApi({ 'db-a': '4' });
    const steps = { '5': 'ALTER 5;', '6': 'ALTER 6;' };
    const result = await migrateAllProducts(ctx(), () => cfApi, steps);

    expect(cfApi.appliedSql).toEqual(['ALTER 5;', 'ALTER 6;']);
    expect(result.results[0]).toMatchObject({
      status: 'migrated',
      previous_version: '4',
      migrations_applied: ['5', '6'],
    });
    expect(result.latest_schema_version).toBe('6');
    expect(result.status).toBe('success');
  });

  it('stops at the first failing step and reports which version failed', async () => {
    await seedConfig('prod-a', 'db-a');
    const cfApi = fakeCfApi({ 'db-a': '4' }, ['ALTER 6;']);
    const steps = { '5': 'ALTER 5;', '6': 'ALTER 6;', '7': 'ALTER 7;' };
    const result = await migrateAllProducts(ctx(), () => cfApi, steps);

    // Step 5 applied, step 6 failed, step 7 never attempted.
    expect(cfApi.appliedSql).toEqual(['ALTER 5;']);
    expect(result.status).toBe('partial_failure');
    expect(result.results[0]).toMatchObject({
      status: 'error',
      migrations_applied: ['5'],
      error: 'Migration to v6 failed',
    });
  });

  it('pins current behavior for a below-latest product with an empty step map', async () => {
    // MIGRATION_STEPS is empty today, so a v3 database has no steps to
    // apply: the product reports status "migrated" with an empty
    // migrations_applied and its version unchanged. If a future migration
    // is added, this test SHOULD fail and be updated.
    await seedConfig('prod-a', 'db-a');
    const result = await migrateAllProducts(ctx(), () => fakeCfApi({ 'db-a': '3' }));
    expect(result.results[0]).toMatchObject({
      status: 'migrated',
      previous_version: '3',
      new_version: '3',
      migrations_applied: [],
    });
  });
});

describe('getProductMigrationStatus', () => {
  it('reports up-to-date with no-op instructions when the version matches', async () => {
    await seedConfig('prod-a', 'db-a');
    const result = await getProductMigrationStatus('prod-a', ctx(), () =>
      fakeCfApi({ 'db-a': '4' }),
    );
    expect(result.up_to_date).toBe(true);
    expect(result.current_schema_version).toBe('4');
    expect(result.instructions).toBe('Schema is up to date. No migrations needed.');
  });

  it('swallows version-read failures (database may not be initialized)', async () => {
    await seedConfig('prod-a', 'db-a');
    const result = await getProductMigrationStatus('prod-a', ctx(), () =>
      fakeCfApi({ 'db-a': new Error('boom') }),
    );
    expect(result.current_schema_version).toBeNull();
    expect(result.up_to_date).toBe(false);
    expect(result.instructions).toContain('pnpx wrangler d1 migrations apply');
  });

  it('throws INTERNAL_ERROR for malformed config JSON', async () => {
    await env.CONFIG.put('product:broken:config', '{nope');
    const err = await getProductMigrationStatus('broken', ctx(), () => fakeCfApi({})).catch(
      (e: unknown) => e,
    );
    expect((err as ManagementRequestError).code).toBe('INTERNAL_ERROR');
  });
});
