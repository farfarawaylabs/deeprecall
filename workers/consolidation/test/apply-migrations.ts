/**
 * D1 schema + per-test wipe for integration tests.
 *
 * Imported DIRECTLY by every test file that touches real D1 — deliberately
 * NOT registered as a global vitest setupFile: under vitest-pool-workers a
 * global setup file breaks `vi.mock` module interception in ALL test files
 * of the project (this worker's conflict-resolution and profile-consolidation
 * suites mock @deeprecall/ai). The direct import executes after the importing
 * file's hoisted vi.mock calls, so both work.
 *
 * CAVEAT: relies on per-file module re-evaluation. Setting isolate: false
 * or singleWorker would reuse the module cache across files, silently
 * skipping both the migration and the wipe for later files.
 */
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB_default, env.TEST_MIGRATIONS);

// Storage is isolated per test FILE (not per test), so rows written by one
// test would otherwise leak into the next. Wipe every application table
// between tests to keep them hermetic. Virtual tables and their shadow
// tables are excluded: memories_fts stays in sync via the AFTER DELETE
// trigger on memories, and shadow tables cannot be modified directly.
// (d1_migrations is preserved so the schema stays applied.)
const { results: tables } = await env.DB_default.prepare(
  `SELECT name FROM sqlite_master AS t
   WHERE type = 'table'
     AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
     AND name NOT LIKE '\\_cf%' ESCAPE '\\'
     AND name != 'd1_migrations'
     AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
     AND NOT EXISTS (
       SELECT 1 FROM sqlite_master AS vt
       WHERE vt.sql LIKE 'CREATE VIRTUAL TABLE%'
         AND t.name LIKE vt.name || '\\_%' ESCAPE '\\'
     )`,
).all<{ name: string }>();

// Delete in REVERSE creation order: migrations create parent tables before
// their children, so reversing keeps the wipe safe if a future migration
// adds a cross-table foreign key.
const wipeStatements = [...tables]
  .reverse()
  .map(({ name }) => env.DB_default.prepare(`DELETE FROM "${name}"`));

beforeEach(async () => {
  await env.DB_default.batch(wipeStatements);
});
