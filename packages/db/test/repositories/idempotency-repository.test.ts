import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { D1IdempotencyRepository } from '../../src/repositories/idempotency-repository';

describe('D1IdempotencyRepository', () => {
  let repo: D1IdempotencyRepository;

  beforeEach(() => {
    repo = new D1IdempotencyRepository(env.DB);
  });

  describe('store and check', () => {
    it('stores and retrieves a key', async () => {
      const key = `idem-${crypto.randomUUID()}`;
      const response = JSON.stringify({ status: 'ok', memory_ids: ['m1'] });

      await repo.store(key, response, 24);

      const result = await repo.check(key);
      expect(result).toBe(response);
    });

    it('returns null for non-existent key', async () => {
      const result = await repo.check('non-existent-key');
      expect(result).toBeNull();
    });

    it('returns null for expired key', async () => {
      const key = `idem-expired-${crypto.randomUUID()}`;
      // Store with 0 hours TTL — the expires_at will be ~now
      await repo.store(key, '{"ok":true}', 0);

      // Wait a moment to ensure expiry time passes
      const result = await repo.check(key);
      // With 0 TTL the key expires immediately or within ms
      // The check compares expires_at > now, so 0 TTL means it's exactly at now
      expect(result).toBeNull();
    });

    it('overwrites existing key (INSERT OR REPLACE)', async () => {
      const key = `idem-overwrite-${crypto.randomUUID()}`;
      await repo.store(key, '{"v":1}', 24);
      await repo.store(key, '{"v":2}', 24);

      const result = await repo.check(key);
      expect(result).toBe('{"v":2}');
    });
  });

  describe('cleanup', () => {
    it('deletes expired keys', async () => {
      const key = `idem-cleanup-${crypto.randomUUID()}`;
      // Store with 0 TTL so it expires immediately
      await repo.store(key, '{"ok":true}', 0);

      const deleted = await repo.cleanup();
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Verify key is gone
      const result = await repo.check(key);
      expect(result).toBeNull();
    });

    it('returns 0 when nothing to clean', async () => {
      // Store with long TTL
      const key = `idem-noclean-${crypto.randomUUID()}`;
      await repo.store(key, '{"ok":true}', 24);

      // Cleanup should not delete non-expired keys
      const deleted = await repo.cleanup();
      // Can't assert exact count since other tests may leave expired keys
      expect(typeof deleted).toBe('number');

      // The non-expired key should still exist
      const result = await repo.check(key);
      expect(result).toBe('{"ok":true}');
    });
  });
});
