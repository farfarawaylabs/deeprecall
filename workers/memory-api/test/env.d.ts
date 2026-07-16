declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    /** Real local D1 for integration tests (added via miniflare.d1Databases). */
    DB_default: D1Database;
    /** Real local R2 for the document pipeline test (added via miniflare.r2Buckets). */
    DOCUMENTS_BUCKET: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
  }
}
