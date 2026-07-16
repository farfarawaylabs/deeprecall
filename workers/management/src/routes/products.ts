import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../types';
import { ManagementRequestError } from '../errors';
import { listAllProductConfigs } from '../product-registry';
import { managementContext } from '../context';
import {
  decommissionProduct,
  migrateKeyIndex,
  onboardProduct,
  rotateProductKey,
} from '../provisioning/provisioning-service';
import { getProductMigrationStatus } from '../migrations/migrations-service';

// ─── Zod Schemas ───────────────────────────────────────────

const ProductIdSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Product ID must be lowercase alphanumeric with hyphens (e.g., 'my-product')",
  );

const OnboardRequestSchema = z.object({
  product_id: ProductIdSchema,
  name: z.string().min(1).max(100),
  policy_overrides: z.record(z.string(), z.unknown()).optional().default({}),
  features: z.record(z.string(), z.unknown()).optional().default({}),
  answer_model: z
    .string()
    .regex(
      /^(anthropic|openai|google):.+/,
      "answer_model must be '<provider>:<model-id>' with provider anthropic, openai, or google",
    )
    .optional(),
});

const DeleteConfirmSchema = z.object({ confirm: z.literal(true) });

// ─── Routes ────────────────────────────────────────────────

const products = new Hono<AppBindings>();

/**
 * POST /products/onboard
 * Onboard a new product: create D1 database, Vectorize index, generate API key, register in KV.
 */
products.post('/onboard', async (c) => {
  const body = await c.req.json();
  const parsed = OnboardRequestSchema.safeParse(body);

  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid onboard request', parsed.error.flatten());
  }

  try {
    const result = await onboardProduct(parsed.data, managementContext(c));
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * GET /products
 * List all registered products from KV.
 */
products.get('/', async (c) => {
  const productConfigs = await listAllProductConfigs(c.env.CONFIG);

  return c.json({
    products: productConfigs,
    total: productConfigs.length,
  });
});

/**
 * POST /products/migrate-key-index
 * One-time backfill: build the hashed `apikey:<hash>` auth index (and the
 * `:api_key_hash` bookkeeping entry) from the legacy plaintext
 * `product:<id>:api_key` entries. Idempotent — safe to re-run.
 *
 * Rollout: run WITHOUT cleanup first (while the old scan-based auth still reads
 * plaintext), deploy the hash-based memory-api, verify, then re-run with
 * `?cleanup=true` to delete the legacy plaintext entries. Freeze BOTH onboarding
 * and key rotation until the new memory-api is deployed — during the window the
 * old worker still authenticates by plaintext, which new/rotated keys skip.
 */
products.post('/migrate-key-index', async (c) => {
  const cleanup = c.req.query('cleanup') === 'true';
  try {
    const result = await migrateKeyIndex(cleanup, managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * POST /products/:id/rotate-key
 * Generate a new API key for a product, replacing the existing one.
 *
 * Keys are hashed at rest, so the plaintext cannot be retrieved after creation
 * — there is no GET-key endpoint. Rotation is the only recovery path for a lost
 * or leaked key, and it is the sole moment (besides onboard) a key is shown.
 *
 * The memory-api auth middleware resolves keys via a hashed KV index, so the new
 * key takes effect as soon as the KV write propagates and the old key stops
 * working once its index entry is deleted — no redeploy required. Works for the
 * "default" product too.
 */
products.post('/:id/rotate-key', async (c) => {
  const productId = c.req.param('id');

  const idResult = ProductIdSchema.safeParse(productId);
  if (!idResult.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid product ID format');
  }

  try {
    const result = await rotateProductKey(productId, managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * POST /products/:id/migrate
 * Check migration status for a specific product's D1 database.
 * Since running migrations via REST API is fragile for multi-statement DDL,
 * this endpoint returns guidance for running migrations via wrangler CLI.
 */
products.post('/:id/migrate', async (c) => {
  try {
    const result = await getProductMigrationStatus(c.req.param('id'), managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * DELETE /products/:id
 * Delete a product and all its Cloudflare resources (D1, Vectorize, R2 objects, KV entries).
 * Requires `confirm: true` in the request body as a destructive operation safeguard.
 * The "default" product cannot be deleted.
 *
 * After deletion, the operator must manually remove the DB_<id> and VEC_<id> bindings
 * from workers/data/wrangler.jsonc and redeploy the data worker.
 */
products.delete('/:id', async (c) => {
  const productId = c.req.param('id');

  // Validate product ID format
  const idResult = ProductIdSchema.safeParse(productId);
  if (!idResult.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid product ID format');
  }

  // Block deletion of the default product
  if (productId === 'default') {
    return apiError(c, 400, 'VALIDATION_ERROR', "The 'default' product cannot be deleted");
  }

  // Require explicit confirmation (Zod safeParse handles missing/malformed body)
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Destructive operation requires { "confirm": true } in the request body',
    );
  }

  const confirmResult = DeleteConfirmSchema.safeParse(body);
  if (!confirmResult.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Destructive operation requires { "confirm": true } in the request body',
    );
  }

  try {
    const result = await decommissionProduct(productId, managementContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof ManagementRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

export { products };
