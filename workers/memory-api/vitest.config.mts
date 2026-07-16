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
          // Local in-memory CONFIG KV so auth resolution (apikey:<hash> lookup)
          // can be exercised in tests.
          kvNamespaces: ['CONFIG'],
          // Real local D1 so integration tests (e.g. idempotency double-send)
          // exercise the actual repositories instead of recording stubs.
          d1Databases: ['DB_default'],
          // Real local R2 so the document pipeline integration test can
          // verify blob upload/delete against actual bucket semantics.
          r2Buckets: ['DOCUMENTS_BUCKET'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Explicitly blank out every secret: the pool loads .dev.vars, so
            // without this override a developer machine with real secrets would
            // have SELF.fetch tests ship live telemetry to Axiom (and behave
            // differently than a fresh clone). Empty strings are falsy, so the
            // guards (e.g. loggingMiddleware's axiomConfig check) fire
            // deterministically everywhere.
            AXIOM_API_TOKEN: '',
            AXIOM_DATASET: '',
            ANTHROPIC_API_KEY: '',
            ADMIN_KEY: '',
            AWS_REGION: '',
            AWS_ACCESS_KEY_ID: '',
            AWS_SECRET_ACCESS_KEY: '',
            AWS_SESSION_TOKEN: '',
            OPENAI_API_KEY: '',
            GOOGLE_API_KEY: '',
          },
        },
      };
    }),
  ],
});
