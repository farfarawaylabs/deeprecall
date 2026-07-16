import { Logger } from '@deeprecall/logger';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATION_STEPS,
  SCHEMA_VERSION_SQL,
  getPendingVersions,
  latestVersion,
} from '@deeprecall/db';
import {
  defaultCfApiFactory,
  requireCfApi,
  type CloudflareApi,
  type CloudflareApiFactory,
  type ManagementContext,
} from '../context';
import { ManagementRequestError } from '../errors';
import { listAllProductConfigs, type ProductConfig } from '../product-registry';

/**
 * Read a product database's current schema version over the D1 REST API.
 * Returns null when the row is missing or malformed; throws when the API
 * call itself fails (callers decide how to log/handle that).
 */
async function readSchemaVersion(cfApi: CloudflareApi, dbId: string): Promise<string | null> {
  const result = (await cfApi.executeD1Sql(dbId, SCHEMA_VERSION_SQL)) as Array<{
    results: Array<{ value: string }>;
  }>;
  if (Array.isArray(result) && result[0]?.results?.[0]?.value) {
    return result[0].results[0].value;
  }
  return null;
}

export interface ProductMigrationStatus {
  product_id: string;
  db_name: string;
  db_id: string;
  current_schema_version: string | null;
  latest_schema_version: string;
  up_to_date: boolean;
  error?: string;
}

/** Response body for GET /migrations/status. */
export interface MigrationsStatusResult {
  status: 'all_current' | 'migrations_pending';
  latest_schema_version: string;
  total_products: number;
  pending_migrations: number;
  products: ProductMigrationStatus[];
}

/** Check schema versions across all registered products. */
export async function getMigrationsStatus(
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory = defaultCfApiFactory,
): Promise<MigrationsStatusResult> {
  const cfApi = requireCfApi(ctx, cfApiFactory);
  const productConfigs = await listAllProductConfigs(ctx.env.CONFIG);

  // Query each product's schema version
  const statuses: ProductMigrationStatus[] = await Promise.all(
    productConfigs.map(async (config): Promise<ProductMigrationStatus> => {
      let currentVersion: string | null = null;
      let error: string | undefined;

      try {
        currentVersion = await readSchemaVersion(cfApi, config.db_id);
      } catch (err) {
        if (ctx.logCtx) {
          Logger.error(ctx.logCtx, 'Failed to query schema version', {
            product_id: config.product_id,
            db_id: config.db_id,
            error: err instanceof Error ? err.message : 'Unknown',
          });
        }
        error = 'Failed to query schema version';
      }

      return {
        product_id: config.product_id,
        db_name: config.db_name,
        db_id: config.db_id,
        current_schema_version: currentVersion,
        latest_schema_version: LATEST_SCHEMA_VERSION,
        up_to_date: currentVersion === LATEST_SCHEMA_VERSION,
        ...(error ? { error } : {}),
      };
    }),
  );

  const allUpToDate = statuses.every((s) => s.up_to_date);
  const pendingCount = statuses.filter((s) => !s.up_to_date).length;

  return {
    status: allUpToDate ? 'all_current' : 'migrations_pending',
    latest_schema_version: LATEST_SCHEMA_VERSION,
    total_products: statuses.length,
    pending_migrations: pendingCount,
    products: statuses,
  };
}

export interface MigrateAllResult {
  product_id: string;
  db_name: string;
  previous_version: string | null;
  new_version: string | null;
  status: 'migrated' | 'up_to_date' | 'error';
  migrations_applied: string[];
  error?: string;
}

/** Response body for POST /migrations/migrate-all. */
export interface MigrateAllSummary {
  status: 'no_products' | 'success' | 'partial_failure';
  message?: string;
  latest_schema_version?: string;
  total_products?: number;
  migrated?: number;
  up_to_date?: number;
  errors?: number;
  results: MigrateAllResult[];
}

/** Run pending migrations across all registered product databases. */
export async function migrateAllProducts(
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory = defaultCfApiFactory,
  steps: Record<string, string> = MIGRATION_STEPS,
): Promise<MigrateAllSummary> {
  const cfApi = requireCfApi(ctx, cfApiFactory);
  // Latest version follows the injected step map so tests can exercise the
  // application loop; with the default map this equals LATEST_SCHEMA_VERSION.
  const latest = latestVersion(steps);
  const productConfigs = await listAllProductConfigs(ctx.env.CONFIG);

  if (productConfigs.length === 0) {
    return {
      status: 'no_products',
      message: 'No registered products found in KV',
      results: [],
    };
  }

  // Migrate each product sequentially to avoid overwhelming the API
  const results: MigrateAllResult[] = [];

  for (const config of productConfigs) {
    let currentVersion: string | null = null;

    // Read current schema version
    try {
      currentVersion = await readSchemaVersion(cfApi, config.db_id);
    } catch (err) {
      if (ctx.logCtx) {
        Logger.error(ctx.logCtx, 'Failed to read schema version for migration', {
          product_id: config.product_id,
          db_id: config.db_id,
          error: err instanceof Error ? err.message : 'Unknown',
        });
      }
      results.push({
        product_id: config.product_id,
        db_name: config.db_name,
        previous_version: null,
        new_version: null,
        status: 'error',
        migrations_applied: [],
        error: 'Failed to read schema version',
      });
      continue;
    }

    if (currentVersion === latest) {
      results.push({
        product_id: config.product_id,
        db_name: config.db_name,
        previous_version: currentVersion,
        new_version: currentVersion,
        status: 'up_to_date',
        migrations_applied: [],
      });
      continue;
    }

    // Determine and apply pending migrations
    const pendingVersions = getPendingVersions(currentVersion, steps);
    const appliedVersions: string[] = [];
    let lastError: string | undefined;

    for (const version of pendingVersions) {
      const sql = steps[version]!;
      try {
        // Send all statements for this version as a single API call
        // (matches the onboard pattern with INITIAL_SCHEMA_SQL)
        await cfApi.executeD1Sql(config.db_id, sql);
        appliedVersions.push(version);
      } catch (err) {
        if (ctx.logCtx) {
          Logger.error(ctx.logCtx, 'Migration step failed', {
            product_id: config.product_id,
            db_id: config.db_id,
            target_version: version,
            error: err instanceof Error ? err.message : 'Unknown',
          });
        }
        lastError = `Migration to v${version} failed`;
        break;
      }
    }

    // Read the new version after migrations
    let newVersion = currentVersion;
    try {
      const readBack = await readSchemaVersion(cfApi, config.db_id);
      if (readBack !== null) {
        newVersion = readBack;
      }
    } catch {
      // If we can't read the version after migration, use last applied
    }

    results.push({
      product_id: config.product_id,
      db_name: config.db_name,
      previous_version: currentVersion,
      new_version: newVersion,
      status: lastError ? 'error' : 'migrated',
      migrations_applied: appliedVersions,
      ...(lastError ? { error: lastError } : {}),
    });
  }

  const migrated = results.filter((r) => r.status === 'migrated').length;
  const upToDate = results.filter((r) => r.status === 'up_to_date').length;
  const errors = results.filter((r) => r.status === 'error').length;

  return {
    status: errors > 0 ? 'partial_failure' : 'success',
    latest_schema_version: latest,
    total_products: results.length,
    migrated,
    up_to_date: upToDate,
    errors,
    results,
  };
}

/** Response body for POST /products/:id/migrate. */
export interface ProductMigrationStatusResult {
  product_id: string;
  db_name: string;
  db_id: string;
  current_schema_version: string | null;
  latest_schema_version: string;
  up_to_date: boolean;
  instructions: string;
}

/**
 * Check migration status for a single product's D1 database. Running
 * migrations via the REST API is fragile for multi-statement DDL, so this
 * returns guidance for the wrangler CLI instead of applying anything.
 * Unlike the fleet-wide endpoints, missing API credentials are tolerated —
 * the version simply reads as unknown.
 */
export async function getProductMigrationStatus(
  productId: string,
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory = defaultCfApiFactory,
): Promise<ProductMigrationStatusResult> {
  const configStr = await ctx.env.CONFIG.get(`product:${productId}:config`);
  if (!configStr) {
    throw new ManagementRequestError(`Product '${productId}' not found`, 404, 'NOT_FOUND');
  }

  let config: ProductConfig;
  try {
    config = JSON.parse(configStr) as ProductConfig;
  } catch {
    throw new ManagementRequestError(
      `Invalid config for product '${productId}'`,
      500,
      'INTERNAL_ERROR',
    );
  }

  // Try to read schema version via Cloudflare API
  const apiToken = ctx.env.CLOUDFLARE_API_TOKEN;
  const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  let currentVersion: string | null = null;

  if (apiToken && accountId) {
    const cfApi = cfApiFactory(apiToken, accountId);
    try {
      currentVersion = await readSchemaVersion(cfApi, config.db_id);
    } catch {
      // Unable to query — database may not be initialized
    }
  }

  return {
    product_id: productId,
    db_name: config.db_name,
    db_id: config.db_id,
    current_schema_version: currentVersion,
    latest_schema_version: LATEST_SCHEMA_VERSION,
    up_to_date: currentVersion === LATEST_SCHEMA_VERSION,
    instructions:
      currentVersion === LATEST_SCHEMA_VERSION
        ? 'Schema is up to date. No migrations needed.'
        : `Run pending migrations with: pnpx wrangler d1 migrations apply ${config.db_name} --env dev --remote`,
  };
}
