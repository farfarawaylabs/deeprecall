import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

// Characterization tests written BEFORE the C2 extraction: they pin every
// validation / guard branch reachable without a real Cloudflare API token
// (the test env deliberately has no CLOUDFLARE_API_TOKEN/ACCOUNT_ID, so the
// CONFIGURATION_ERROR paths are the natural stopping point). Provisioning
// internals (rollback, KV writes) are covered by BL unit tests post-move.

const ADMIN = { 'X-Admin-Key': 'test-admin-key', 'Content-Type': 'application/json' };

async function seedProduct(productId: string): Promise<void> {
  await env.CONFIG.put(
    `product:${productId}:config`,
    JSON.stringify({
      product_id: productId,
      name: 'Seeded',
      policy_overrides: {},
      features: {},
      db_id: 'db-uuid-1',
      db_name: `deeprecall-db-${productId}-dev`,
      vectorize_name: `deeprecall-vectors-${productId}-dev`,
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  );
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

describe('POST /admin/products/onboard', () => {
  it('rejects an invalid product_id with 400 and details', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/onboard', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ product_id: 'Bad_ID!', name: 'X' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid onboard request');
    expect(body.error.details).toBeDefined();
  });

  it('rejects a malformed answer_model with 400', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/onboard', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ product_id: 'ok-product', name: 'X', answer_model: 'not-a-spec' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 CONFLICT when the product already exists', async () => {
    await seedProduct('taken-product');
    const res = await SELF.fetch('http://localhost/admin/products/onboard', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ product_id: 'taken-product', name: 'X' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe("Product 'taken-product' already exists");
  });

  it('returns 500 CONFIGURATION_ERROR when Cloudflare secrets are unset', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/onboard', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ product_id: 'fresh-product', name: 'X' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('CONFIGURATION_ERROR');
    expect(body.error.message).toBe(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets must be configured',
    );
  });
});

describe('DELETE /admin/products/:id', () => {
  it('rejects an invalid product id format', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/ab', {
      method: 'DELETE',
      headers: ADMIN,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toBe('Invalid product ID format');
  });

  it('refuses to delete the default product', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/default', {
      method: 'DELETE',
      headers: ADMIN,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toBe(
      "The 'default' product cannot be deleted",
    );
  });

  it('requires a JSON body with confirm: true (missing body)', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/some-product', {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toBe(
      'Destructive operation requires { "confirm": true } in the request body',
    );
  });

  it('requires confirm to be literally true', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/some-product', {
      method: 'DELETE',
      headers: ADMIN,
      body: JSON.stringify({ confirm: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unregistered product', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/ghost-product', {
      method: 'DELETE',
      headers: ADMIN,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.message).toBe(
      "Product 'ghost-product' not found",
    );
  });

  it('returns 500 CONFIGURATION_ERROR for a registered product when secrets are unset', async () => {
    await seedProduct('victim-product');
    const res = await SELF.fetch('http://localhost/admin/products/victim-product', {
      method: 'DELETE',
      headers: ADMIN,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('POST /admin/products/:id/migrate', () => {
  it('returns 404 for an unregistered product', async () => {
    const res = await SELF.fetch('http://localhost/admin/products/ghost-product/migrate', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(404);
  });

  it('reports unknown current version with wrangler instructions when secrets are unset', async () => {
    await seedProduct('mig-product');
    const res = await SELF.fetch('http://localhost/admin/products/mig-product/migrate', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product_id: string;
      db_name: string;
      current_schema_version: string | null;
      latest_schema_version: string;
      up_to_date: boolean;
      instructions: string;
    };
    expect(body.product_id).toBe('mig-product');
    expect(body.current_schema_version).toBeNull();
    expect(body.latest_schema_version).toBe('4');
    expect(body.up_to_date).toBe(false);
    expect(body.instructions).toBe(
      'Run pending migrations with: pnpx wrangler d1 migrations apply deeprecall-db-mig-product-dev --env dev --remote',
    );
  });
});

describe('migrations endpoints without Cloudflare secrets', () => {
  it('GET /admin/migrations/status returns 500 CONFIGURATION_ERROR', async () => {
    const res = await SELF.fetch('http://localhost/admin/migrations/status', {
      headers: ADMIN,
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe('CONFIGURATION_ERROR');
  });

  it('POST /admin/migrations/migrate-all returns 500 CONFIGURATION_ERROR', async () => {
    const res = await SELF.fetch('http://localhost/admin/migrations/migrate-all', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('GET /admin/products', () => {
  // Storage is isolated per test FILE (not per test), so products seeded by
  // earlier tests in this file are still in KV — start from a clean slate.
  beforeEach(async () => {
    const { keys } = await env.CONFIG.list();
    await Promise.all(keys.map((key) => env.CONFIG.delete(key.name)));
  });

  it('lists seeded product configs', async () => {
    await seedProduct('list-product');
    const res = await SELF.fetch('http://localhost/admin/products', { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Array<{ product_id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.products[0]!.product_id).toBe('list-product');
  });
});
