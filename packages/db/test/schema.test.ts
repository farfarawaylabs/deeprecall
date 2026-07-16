import { describe, it, expect } from 'vitest';
import initialSchemaFile from '../src/migrations/0001_initial_schema.sql?raw';
import {
  INITIAL_SCHEMA_SQL,
  MIGRATION_STEPS,
  BASELINE_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  getPendingVersions,
} from '../src/schema';

describe('INITIAL_SCHEMA_SQL', () => {
  it('is byte-identical to the canonical migration file', () => {
    // The management worker applies INITIAL_SCHEMA_SQL over the D1 REST API
    // at onboarding; wrangler-managed databases apply the .sql file. This
    // test is what makes "kept in sync" a guarantee instead of a comment.
    expect(INITIAL_SCHEMA_SQL).toBe(initialSchemaFile);
  });

  it('records the baseline schema version the constants advertise', () => {
    expect(INITIAL_SCHEMA_SQL).toContain(
      `INSERT OR IGNORE INTO db_metadata (key, value) VALUES ('schema_version', '${BASELINE_SCHEMA_VERSION}');`,
    );
  });
});

describe('LATEST_SCHEMA_VERSION', () => {
  it('equals the baseline while no migration steps exist', () => {
    // When MIGRATION_STEPS gains entries, LATEST must track the top key —
    // covered by the injectable-steps tests below.
    expect(Object.keys(MIGRATION_STEPS)).toHaveLength(0);
    expect(LATEST_SCHEMA_VERSION).toBe(BASELINE_SCHEMA_VERSION);
  });
});

describe('getPendingVersions', () => {
  const steps = { '5': 'ALTER 5;', '6': 'ALTER 6;', '7': 'ALTER 7;' };

  it('returns every step above the current version, in ascending order', () => {
    expect(getPendingVersions('4', steps)).toEqual(['5', '6', '7']);
    expect(getPendingVersions('5', steps)).toEqual(['6', '7']);
    expect(getPendingVersions('6', steps)).toEqual(['7']);
  });

  it('returns nothing when already at the latest version', () => {
    expect(getPendingVersions('7', steps)).toEqual([]);
  });

  it('treats an unknown current version as 0 and returns all steps', () => {
    expect(getPendingVersions(null, steps)).toEqual(['5', '6', '7']);
  });

  it('skips gaps in the step map', () => {
    expect(getPendingVersions('4', { '5': 'a', '7': 'b' })).toEqual(['5', '7']);
  });

  it('returns empty for the real (currently empty) step map', () => {
    expect(getPendingVersions(BASELINE_SCHEMA_VERSION)).toEqual([]);
    expect(getPendingVersions(null)).toEqual([]);
  });
});
