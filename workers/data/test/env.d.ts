declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB_default: D1Database;
    DOCUMENTS_BUCKET: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
    /** Self-service binding so tests exercise DataService over real RPC. */
    DATA: Service<import('../src/index').DataService>;
  }
}
