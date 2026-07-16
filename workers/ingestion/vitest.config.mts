import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(
        __dirname,
        '..',
        '..',
        'packages',
        'db',
        'src',
        'migrations',
      );
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Real local D1 so integration tests exercise the actual
          // repositories, FK constraints, and FTS triggers. Vectorize and
          // Workers AI have no miniflare simulator — tests stub those.
          d1Databases: ['DB_default'],
          bindings: {
            // Provide the internal-auth secret so the fetch handler (fail-closed)
            // is exercised as it runs in production.
            INTERNAL_SERVICE_KEY: 'test-internal-key',
            TEST_MIGRATIONS: migrations,
            // Explicitly blank out every secret: the pool loads .dev.vars, so
            // without this override a developer machine with real secrets would
            // have tests ship live telemetry to Axiom or call real LLM APIs
            // (and behave differently than a fresh clone). Empty strings are
            // falsy, so the guards fire deterministically everywhere.
            AXIOM_API_TOKEN: '',
            AXIOM_DATASET: '',
            ANTHROPIC_API_KEY: '',
            AWS_REGION: '',
            AWS_ACCESS_KEY_ID: '',
            AWS_SECRET_ACCESS_KEY: '',
            AWS_SESSION_TOKEN: '',
          },
        },
      };
    }),
  ],
});
