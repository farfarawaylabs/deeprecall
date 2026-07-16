declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    /** Real local D1 for integration tests (added via miniflare.d1Databases). */
    DB_default: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
