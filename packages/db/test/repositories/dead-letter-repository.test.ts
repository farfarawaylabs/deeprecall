import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { D1DeadLetterRepository } from '../../src/repositories/dead-letter-repository';
import type { DeadLetterEntry } from '../../src/interfaces';

function makeEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    queue_name: 'consolidation',
    payload: JSON.stringify({ type: 'test', scope: { user_id: 'u1' } }),
    error: 'Test error',
    attempts: 3,
    first_failed_at: now,
    last_failed_at: now,
    ...overrides,
  };
}

describe('D1DeadLetterRepository', () => {
  let repo: D1DeadLetterRepository;

  beforeEach(() => {
    repo = new D1DeadLetterRepository(env.DB);
  });

  describe('create and getById', () => {
    it('creates and retrieves a dead letter', async () => {
      const entry = makeEntry();
      await repo.create(entry);

      const found = await repo.getById(entry.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(entry.id);
      expect(found!.queue_name).toBe('consolidation');
      expect(found!.error).toBe('Test error');
      expect(found!.attempts).toBe(3);
    });

    it('returns null for non-existent id', async () => {
      const found = await repo.getById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('list', () => {
    it('lists dead letters ordered by last_failed_at descending', async () => {
      const e1 = makeEntry({
        last_failed_at: '2025-01-01T00:00:00.000Z',
      });
      const e2 = makeEntry({
        last_failed_at: '2025-01-02T00:00:00.000Z',
      });

      await repo.create(e1);
      await repo.create(e2);

      const list = await repo.list(10);
      const ids = list.map((e) => e.id);
      const idx1 = ids.indexOf(e1.id);
      const idx2 = ids.indexOf(e2.id);
      // e2 (newer) should come before e1 (older)
      expect(idx2).toBeLessThan(idx1);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.create(makeEntry());
      }

      const list = await repo.list(2);
      expect(list).toHaveLength(2);
    });
  });

  describe('count', () => {
    it('counts dead letters', async () => {
      const before = await repo.count();
      await repo.create(makeEntry());
      await repo.create(makeEntry());
      const after = await repo.count();

      expect(after - before).toBe(2);
    });
  });

  describe('deleteById', () => {
    it('deletes a dead letter', async () => {
      const entry = makeEntry();
      await repo.create(entry);

      await repo.deleteById(entry.id);
      const found = await repo.getById(entry.id);
      expect(found).toBeNull();
    });
  });
});
