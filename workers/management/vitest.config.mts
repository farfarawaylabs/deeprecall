import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Local CONFIG KV + admin secret so admin-gated KV endpoints
        // (e.g. the API-key index migration) can be exercised in tests.
        kvNamespaces: ['CONFIG'],
        bindings: {
          ADMIN_KEY: 'test-admin-key',
          // Explicitly blank out the Cloudflare API credentials: the pool
          // loads .dev.vars, so without this override a developer machine
          // with real secrets would have provisioning tests hit the REAL
          // Cloudflare API (and behave differently than a fresh clone).
          // Empty strings are falsy, so the CONFIGURATION_ERROR guards
          // fire deterministically everywhere.
          CLOUDFLARE_API_TOKEN: '',
          CLOUDFLARE_ACCOUNT_ID: '',
        },
      },
    }),
  ],
});
