import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Provide the internal-auth secret so the fetch handler (fail-closed)
        // is exercised as it runs in production.
        bindings: { INTERNAL_SERVICE_KEY: 'test-internal-key' },
      },
    }),
  ],
});
