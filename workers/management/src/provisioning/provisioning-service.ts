import { Logger } from '@deeprecall/logger';
import { INITIAL_SCHEMA_SQL } from '@deeprecall/db';
import type { VectorizeMetadataIndexType } from '../cloudflare-api';
import {
  defaultCfApiFactory,
  requireCfApi,
  type CloudflareApiFactory,
  type ManagementContext,
} from '../context';
import { ManagementRequestError } from '../errors';
import { getProductConfig, type ProductConfig } from '../product-registry';
import { sha256Hex } from '@deeprecall/http';

// Metadata indexes required on every product's Vectorize index for scoped
// queries to work. Without these, `filter: { user_id: ... }` etc. silently
// returns zero results — no error, no warning. Cloudflare allows up to 10
// metadata indexes per index; we claim 6.
//
// The first four (user_id, agent_id, status, type) match the filter keys
// currently set by packages/vectorize/src/vectorize-service.ts. The last two
// (source_type, confidence) are pre-provisioned for admin/inspection paths
// that may need them — creating metadata indexes retroactively does not
// index vectors inserted beforehand, so we provision them up front.
export const REQUIRED_METADATA_INDEXES: ReadonlyArray<{
  propertyName: string;
  type: VectorizeMetadataIndexType;
}> = [
  { propertyName: 'user_id', type: 'string' },
  { propertyName: 'agent_id', type: 'string' },
  { propertyName: 'status', type: 'string' },
  { propertyName: 'type', type: 'string' },
  { propertyName: 'source_type', type: 'string' },
  { propertyName: 'confidence', type: 'number' },
];

/** Validated onboard request (schema validation happens in the route). */
export interface OnboardInput {
  product_id: string;
  name: string;
  policy_overrides: Record<string, unknown>;
  features: Record<string, unknown>;
  answer_model?: string;
}

/** Data-worker wrangler.jsonc snippet returned to the operator at onboarding. */
export interface WranglerSnippet {
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  vectorize: Array<{ binding: string; index_name: string }>;
}

/** Response body for POST /products/onboard (201). */
export interface OnboardResult {
  product_id: string;
  api_key: string;
  db_name: string;
  db_id: string;
  vectorize_name: string;
  wrangler_snippet: WranglerSnippet;
  migration_warning: string | undefined;
  message: string;
}

/**
 * Onboard a new product: create its D1 database and Vectorize index (with
 * the 6 required metadata indexes), apply the baseline schema over the D1
 * REST API, generate a show-once API key (only the SHA-256 hash is
 * persisted), and register everything in KV LAST — so a partially failed
 * onboard never leaves a resolvable product behind.
 *
 * Rollback: a Vectorize/metadata-index failure deletes the resources
 * created before it. A schema-migration failure does NOT roll back — the
 * migration can be retried, so the product is registered with a warning.
 */
export async function onboardProduct(
  input: OnboardInput,
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory = defaultCfApiFactory,
): Promise<OnboardResult> {
  const { product_id, name, policy_overrides, features, answer_model } = input;

  // Check product does not already exist
  const existingConfig = await ctx.env.CONFIG.get(`product:${product_id}:config`);
  if (existingConfig) {
    throw new ManagementRequestError(`Product '${product_id}' already exists`, 409, 'CONFLICT');
  }

  const cfApi = requireCfApi(ctx, cfApiFactory);

  const envSuffix = ctx.env.ENVIRONMENT;
  if (envSuffix !== 'dev' && envSuffix !== 'prod') {
    throw new ManagementRequestError(
      "ENVIRONMENT var must be set to 'dev' or 'prod' in wrangler.jsonc",
      500,
      'CONFIGURATION_ERROR',
    );
  }

  const dbName = `deeprecall-db-${product_id}-${envSuffix}`;
  const vecName = `deeprecall-vectors-${product_id}-${envSuffix}`;

  // Step 1: Create D1 database
  const logCtx = ctx.logCtx;
  let dbResult: { uuid: string; name: string };
  try {
    dbResult = await cfApi.createD1Database(dbName);
  } catch (err) {
    if (logCtx) {
      Logger.error(logCtx, 'Failed to create D1 database', {
        product_id,
        db_name: dbName,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
    throw new ManagementRequestError(
      'Failed to create D1 database for product',
      500,
      'PROVISIONING_ERROR',
    );
  }

  // Best-effort resource cleanup used when a later provisioning step fails.
  // Errors are logged but never thrown — the caller has already decided to fail the onboard.
  const rollback = async (args: { deleteVectorize: boolean }): Promise<void> => {
    if (args.deleteVectorize) {
      try {
        await cfApi.deleteVectorizeIndex(vecName);
        if (logCtx) {
          Logger.info(logCtx, 'Cleaned up Vectorize index during rollback', {
            product_id,
            vec_name: vecName,
          });
        }
      } catch (cleanupErr) {
        if (logCtx) {
          Logger.error(logCtx, 'Failed to clean up Vectorize index — manual cleanup required', {
            product_id,
            vec_name: vecName,
            error: cleanupErr instanceof Error ? cleanupErr.message : 'Unknown',
          });
        }
      }
    }
    try {
      await cfApi.deleteD1Database(dbResult.uuid);
      if (logCtx) {
        Logger.info(logCtx, 'Cleaned up D1 database during rollback', {
          product_id,
          db_id: dbResult.uuid,
        });
      }
    } catch (cleanupErr) {
      if (logCtx) {
        Logger.error(logCtx, 'Failed to clean up D1 database — manual cleanup required', {
          product_id,
          db_id: dbResult.uuid,
          error: cleanupErr instanceof Error ? cleanupErr.message : 'Unknown',
        });
      }
    }
  };

  // Step 2: Create Vectorize index (if this fails, clean up the D1 database)
  try {
    await cfApi.createVectorizeIndex(vecName, 1024, 'cosine');
  } catch (err) {
    if (logCtx) {
      Logger.error(logCtx, 'Failed to create Vectorize index', {
        product_id,
        vec_name: vecName,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }

    await rollback({ deleteVectorize: false });

    throw new ManagementRequestError(
      'Failed to create Vectorize index for product',
      500,
      'PROVISIONING_ERROR',
    );
  }

  // Step 2b: Create the metadata indexes that `/v1/query` relies on.
  // Without these, filtered queries silently return zero results.
  // Run in parallel and use allSettled so a single failure surfaces which
  // specific property failed (instead of the opaque first-rejection from
  // Promise.all). On any failure we delete the parent index, which also
  // cleans up any metadata indexes that did succeed — so there's no need
  // to tear them down individually.
  const metadataResults = await Promise.allSettled(
    REQUIRED_METADATA_INDEXES.map((idx) =>
      cfApi
        .createVectorizeMetadataIndex(vecName, idx.propertyName, idx.type)
        .then(() => idx.propertyName),
    ),
  );
  const failedProperties = metadataResults.flatMap((r, i) =>
    r.status === 'rejected'
      ? [{ propertyName: REQUIRED_METADATA_INDEXES[i]!.propertyName, reason: r.reason }]
      : [],
  );
  if (failedProperties.length > 0) {
    if (logCtx) {
      Logger.error(logCtx, 'Failed to create Vectorize metadata indexes', {
        product_id,
        vec_name: vecName,
        failed_properties: failedProperties.map((f) => f.propertyName),
        first_error:
          failedProperties[0]!.reason instanceof Error
            ? failedProperties[0]!.reason.message
            : String(failedProperties[0]!.reason),
      });
    }

    await rollback({ deleteVectorize: true });

    throw new ManagementRequestError(
      'Failed to create required Vectorize metadata indexes for product',
      500,
      'PROVISIONING_METADATA_INDEX_ERROR',
      {
        failed_properties: failedProperties.map((f) => f.propertyName),
      },
    );
  }

  // Step 3: Run initial schema migration on the new D1 database
  // If this fails, note the warning but continue — migrations can be retried
  let migrationFailed = false;
  try {
    await cfApi.executeD1Sql(dbResult.uuid, INITIAL_SCHEMA_SQL);
  } catch (err) {
    migrationFailed = true;
    if (logCtx) {
      Logger.error(logCtx, 'Schema migration failed — can be retried', {
        product_id,
        db_id: dbResult.uuid,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  // Step 4: Generate API key. Only its SHA-256 hash is persisted (as the
  // `apikey:<hash>` auth index + a `:api_key_hash` bookkeeping entry); the
  // plaintext is returned once, here, and is never recoverable afterwards.
  const apiKey = crypto.randomUUID();
  const apiKeyHash = await sha256Hex(apiKey);

  // Step 5: Register in KV LAST — only after D1, Vectorize, and migration succeed (or are retriable)
  const dbBinding = `DB_${product_id}`;
  const vecBinding = `VEC_${product_id}`;
  const config: ProductConfig = {
    product_id,
    name,
    policy_overrides,
    features,
    // Omitted from the stored JSON when undefined.
    answer_model,
    db_id: dbResult.uuid,
    db_name: dbName,
    vectorize_name: vecName,
    created_at: new Date().toISOString(),
  };

  await Promise.all([
    ctx.env.CONFIG.put(`apikey:${apiKeyHash}`, product_id),
    ctx.env.CONFIG.put(`product:${product_id}:api_key_hash`, apiKeyHash),
    ctx.env.CONFIG.put(`product:${product_id}:db_binding`, dbBinding),
    ctx.env.CONFIG.put(`product:${product_id}:vec_binding`, vecBinding),
    ctx.env.CONFIG.put(`product:${product_id}:config`, JSON.stringify(config)),
  ]);

  // Step 6: Build wrangler snippet for the data worker
  const wranglerSnippet: WranglerSnippet = {
    d1_databases: [
      {
        binding: dbBinding,
        database_name: dbName,
        database_id: dbResult.uuid,
      },
    ],
    vectorize: [
      {
        binding: vecBinding,
        index_name: vecName,
      },
    ],
  };

  if (logCtx) {
    Logger.info(logCtx, 'Product onboarded', {
      product_id,
      db_id: dbResult.uuid,
      db_name: dbName,
      vectorize_name: vecName,
    });
  }

  return {
    product_id,
    api_key: apiKey,
    db_name: dbName,
    db_id: dbResult.uuid,
    vectorize_name: vecName,
    wrangler_snippet: wranglerSnippet,
    migration_warning: migrationFailed
      ? "Schema migration failed. Run migrations manually via wrangler CLI before using this product. Vectorize index and metadata indexes are already provisioned — do not rerun setup-product-db.sh's Step 2."
      : undefined,
    message: migrationFailed
      ? 'Product onboarded but schema migration failed. Add the wrangler snippet to workers/data/wrangler.jsonc, run migrations manually, and redeploy.'
      : 'Product onboarded (D1, Vectorize index, and 6 metadata indexes provisioned). Add the wrangler snippet to workers/data/wrangler.jsonc and redeploy.',
  };
}

/** Response body for DELETE /products/:id (200). */
export interface DecommissionResult {
  product_id: string;
  status: 'deleted' | 'partial_failure';
  results: Record<string, { status: 'deleted' | 'failed'; count?: number; error?: string }>;
  retry_note?: string;
  manual_steps: string[];
}

/**
 * Delete a product and all its Cloudflare resources (R2 documents,
 * Vectorize index, D1 database, KV entries). Each step fails independently
 * into the results map; the product's config key is preserved when any
 * infrastructure deletion failed so the operator can retry.
 */
export async function decommissionProduct(
  productId: string,
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory = defaultCfApiFactory,
): Promise<DecommissionResult> {
  const logCtx = ctx.logCtx;

  // Look up product config
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

  const cfApi = requireCfApi(ctx, cfApiFactory);

  const results: DecommissionResult['results'] = {};

  // Step 1: Delete R2 documents via DATA service binding
  try {
    const r2Deleted = await ctx.env.DATA.documentDeleteByPrefix(`${productId}/`);
    results.r2_documents = { status: 'deleted', count: r2Deleted };
    if (logCtx) {
      Logger.info(logCtx, 'R2 documents deleted', { product_id: productId, count: r2Deleted });
    }
  } catch (err) {
    results.r2_documents = { status: 'failed', error: 'Failed to delete R2 documents' };
    if (logCtx) {
      Logger.error(logCtx, 'Failed to delete R2 documents', {
        product_id: productId,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  // Step 2: Delete Vectorize index
  try {
    await cfApi.deleteVectorizeIndex(config.vectorize_name);
    results.vectorize_index = { status: 'deleted' };
    if (logCtx) {
      Logger.info(logCtx, 'Vectorize index deleted', {
        product_id: productId,
        index: config.vectorize_name,
      });
    }
  } catch (err) {
    results.vectorize_index = { status: 'failed', error: 'Failed to delete Vectorize index' };
    if (logCtx) {
      Logger.error(logCtx, 'Failed to delete Vectorize index', {
        product_id: productId,
        index: config.vectorize_name,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  // Step 3: Delete D1 database
  try {
    await cfApi.deleteD1Database(config.db_id);
    results.d1_database = { status: 'deleted' };
    if (logCtx) {
      Logger.info(logCtx, 'D1 database deleted', { product_id: productId, db_id: config.db_id });
    }
  } catch (err) {
    results.d1_database = { status: 'failed', error: 'Failed to delete D1 database' };
    if (logCtx) {
      Logger.error(logCtx, 'Failed to delete D1 database', {
        product_id: productId,
        db_id: config.db_id,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  // Check if any infrastructure deletion failed before cleaning up KV
  const infraFailed = Object.values(results).some((r) => r.status === 'failed');

  // Step 4: Remove KV entries for the product
  // If infrastructure deletion failed, preserve the config key so the operator can retry.
  const kvKeys = [
    `product:${productId}:api_key`, // legacy plaintext (pre-hash migration); harmless if absent
    `product:${productId}:api_key_hash`,
    `product:${productId}:db_binding`,
    `product:${productId}:vec_binding`,
    `product:${productId}:policy_overrides`,
  ];

  // Delete the hashed auth index entry so the key stops resolving immediately.
  const apiKeyHash = await ctx.env.CONFIG.get(`product:${productId}:api_key_hash`);
  if (apiKeyHash) {
    kvKeys.push(`apikey:${apiKeyHash}`);
  }

  // Only delete the config key if all infrastructure was successfully removed
  if (!infraFailed) {
    kvKeys.push(`product:${productId}:config`);
  }

  // Clean up extraction templates (paginated KV list)
  let templateCursor: string | undefined;
  let templatesDone = false;
  while (!templatesDone) {
    const templateList = await ctx.env.CONFIG.list({
      prefix: `template:${productId}:`,
      cursor: templateCursor,
    });
    for (const key of templateList.keys) {
      kvKeys.push(key.name);
    }
    if (templateList.list_complete) {
      templatesDone = true;
    } else {
      templateCursor = templateList.cursor;
    }
  }

  try {
    await Promise.all(kvKeys.map((key) => ctx.env.CONFIG.delete(key)));
    results.kv_entries = { status: 'deleted', count: kvKeys.length };
  } catch (err) {
    results.kv_entries = { status: 'failed', error: 'Failed to delete some KV entries' };
    if (logCtx) {
      Logger.error(logCtx, 'Failed to delete KV entries', {
        product_id: productId,
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  const allSucceeded = Object.values(results).every((r) => r.status === 'deleted');

  if (logCtx) {
    Logger.info(logCtx, 'Product deletion complete', {
      product_id: productId,
      status: allSucceeded ? 'fully_deleted' : 'partial_failure',
    });
  }

  return {
    product_id: productId,
    status: allSucceeded ? 'deleted' : 'partial_failure',
    results,
    ...(infraFailed
      ? {
          retry_note:
            'Some resources failed to delete. The product config was preserved so you can retry this operation.',
        }
      : {}),
    manual_steps: [
      `Remove the DB_${productId} and VEC_${productId} bindings from workers/data/wrangler.jsonc`,
      'Redeploy the data worker: pnpm deploy:dev:data (or deploy:prod:data)',
    ],
  };
}

/** Response body for POST /products/:id/rotate-key (200). */
export interface RotateKeyResult {
  product_id: string;
  api_key: string;
  message: string;
}

/**
 * Generate a new API key for a product, replacing the existing one.
 * Keys are hashed at rest, so rotation is the only recovery path for a
 * lost/leaked key and the sole moment (besides onboard) a key is shown.
 * Takes effect on KV propagation — no redeploy required.
 */
export async function rotateProductKey(
  productId: string,
  ctx: ManagementContext,
): Promise<RotateKeyResult> {
  const config = await getProductConfig(ctx.env.CONFIG, productId);
  if (!config) {
    throw new ManagementRequestError(`Product '${productId}' not found`, 404, 'NOT_FOUND');
  }

  const apiKey = crypto.randomUUID();
  const apiKeyHash = await sha256Hex(apiKey);

  // Delete the previous key's index entry so the old key stops resolving.
  const previousHash = await ctx.env.CONFIG.get(`product:${productId}:api_key_hash`);
  if (previousHash && previousHash !== apiKeyHash) {
    await ctx.env.CONFIG.delete(`apikey:${previousHash}`);
  }

  // Also delete any legacy plaintext entry. Post-migration this is a no-op, but
  // if a rotation happens before the key-index migration's cleanup pass, leaving
  // the plaintext behind would let the OLD (possibly leaked) key keep resolving
  // via the pre-migration scan-based auth — the exact key rotation must revoke.
  await ctx.env.CONFIG.delete(`product:${productId}:api_key`);

  await Promise.all([
    ctx.env.CONFIG.put(`apikey:${apiKeyHash}`, productId),
    ctx.env.CONFIG.put(`product:${productId}:api_key_hash`, apiKeyHash),
  ]);

  if (ctx.logCtx) {
    Logger.info(ctx.logCtx, 'Product API key rotated', { product_id: productId });
  }

  return {
    product_id: productId,
    api_key: apiKey,
    message:
      'API key rotated. The previous key stops working within ~60s (KV propagation); update the product to use the new key. No redeploy is required.',
  };
}

/** Response body for POST /products/migrate-key-index (200). */
export interface MigrateKeyIndexResult {
  migrated: number;
  cleanup: boolean;
  results: Array<{ product_id: string; status: string }>;
}

/**
 * One-time backfill: build the hashed `apikey:<hash>` auth index (and the
 * `:api_key_hash` bookkeeping entry) from the legacy plaintext
 * `product:<id>:api_key` entries. Idempotent — safe to re-run. See the
 * route docs for the zero-downtime rollout ordering.
 */
export async function migrateKeyIndex(
  cleanup: boolean,
  ctx: ManagementContext,
): Promise<MigrateKeyIndexResult> {
  const results: Array<{ product_id: string; status: string }> = [];
  let cursor: string | undefined;
  let done = false;
  while (!done) {
    const list = await ctx.env.CONFIG.list({ prefix: 'product:', cursor });
    for (const key of list.keys) {
      if (!key.name.endsWith(':api_key')) continue;
      const productId = key.name.split(':')[1]!;
      const plaintext = await ctx.env.CONFIG.get(key.name);
      if (!plaintext) continue;

      const hash = await sha256Hex(plaintext);
      await Promise.all([
        ctx.env.CONFIG.put(`apikey:${hash}`, productId),
        ctx.env.CONFIG.put(`product:${productId}:api_key_hash`, hash),
      ]);
      if (cleanup) {
        await ctx.env.CONFIG.delete(key.name);
      }
      results.push({ product_id: productId, status: cleanup ? 'indexed_and_cleaned' : 'indexed' });
    }
    if (list.list_complete) {
      done = true;
    } else {
      cursor = list.cursor;
    }
  }

  if (ctx.logCtx) {
    Logger.info(ctx.logCtx, 'API key index migration run', {
      cleanup,
      migrated: results.length,
    });
  }

  return { migrated: results.length, cleanup, results };
}
