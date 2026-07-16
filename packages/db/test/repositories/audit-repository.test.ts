import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { D1AuditRepository } from '../../src/repositories/audit-repository';
import { D1MemoryRepository } from '../../src/repositories/memory-repository';
import type { MemoryCreateInput } from '../../src/interfaces';

function makeMemoryInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'Test memory',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-audit-test',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'chat',
    confidence: 0.9,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: new Date().toISOString(),
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

describe('D1AuditRepository', () => {
  let auditRepo: D1AuditRepository;
  let memoryRepo: D1MemoryRepository;

  beforeEach(() => {
    auditRepo = new D1AuditRepository(env.DB);
    memoryRepo = new D1MemoryRepository(env.DB);
  });

  describe('log', () => {
    it('creates an audit entry', async () => {
      const memory = await memoryRepo.create(makeMemoryInput());

      await auditRepo.log(
        'created',
        memory.id,
        'Extracted from chat',
        null,
        { content: memory.content },
        'ingestion_pipeline',
      );

      const entries = await auditRepo.getByMemoryId(memory.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('created');
      expect(entries[0].memory_id).toBe(memory.id);
      expect(entries[0].reason).toBe('Extracted from chat');
      expect(entries[0].triggered_by).toBe('ingestion_pipeline');
      expect(entries[0].old_value).toBeNull();
      expect(entries[0].new_value).toContain(memory.content);
    });

    it('stores old and new values as JSON', async () => {
      const memory = await memoryRepo.create(makeMemoryInput());

      await auditRepo.log(
        'superseded',
        memory.id,
        'Newer info available',
        { confidence: 0.5 },
        { confidence: 0.9 },
        'ingestion_pipeline',
      );

      const entries = await auditRepo.getByMemoryId(memory.id);
      expect(JSON.parse(entries[0].old_value!)).toEqual({ confidence: 0.5 });
      expect(JSON.parse(entries[0].new_value!)).toEqual({ confidence: 0.9 });
    });
  });

  describe('getByMemoryId', () => {
    it('returns entries in chronological order', async () => {
      const memory = await memoryRepo.create(makeMemoryInput());

      await auditRepo.log('created', memory.id, null, null, null, 'ingestion_pipeline');
      await auditRepo.log('superseded', memory.id, 'Updated', null, null, 'ingestion_pipeline');

      const entries = await auditRepo.getByMemoryId(memory.id);
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('created');
      expect(entries[1].action).toBe('superseded');
    });

    it('returns empty array for non-existent memory', async () => {
      const entries = await auditRepo.getByMemoryId('non-existent');
      expect(entries).toEqual([]);
    });
  });

  describe('listRecent', () => {
    it('lists recent audit entries for a user', async () => {
      const memory = await memoryRepo.create(makeMemoryInput({ user_id: 'user-recent' }));
      await auditRepo.log('created', memory.id, null, null, null, 'ingestion_pipeline');

      const recent = await auditRepo.listRecent({ user_id: 'user-recent' }, 10);
      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent[0].memory_id).toBe(memory.id);
    });

    it('respects limit', async () => {
      const userId = 'user-limit-audit';
      for (let i = 0; i < 5; i++) {
        const memory = await memoryRepo.create(makeMemoryInput({ user_id: userId }));
        await auditRepo.log('created', memory.id, null, null, null, 'ingestion_pipeline');
      }

      const recent = await auditRepo.listRecent({ user_id: userId }, 2);
      expect(recent).toHaveLength(2);
    });
  });

  describe('deleteByMemoryIds', () => {
    it('deletes audit entries for given memory IDs', async () => {
      const m1 = await memoryRepo.create(makeMemoryInput());
      const m2 = await memoryRepo.create(makeMemoryInput());

      await auditRepo.log('created', m1.id, null, null, null, 'ingestion_pipeline');
      await auditRepo.log('created', m2.id, null, null, null, 'ingestion_pipeline');

      const count = await auditRepo.deleteByMemoryIds([m1.id]);
      expect(count).toBe(1);

      const remaining = await auditRepo.getByMemoryId(m1.id);
      expect(remaining).toHaveLength(0);

      const untouched = await auditRepo.getByMemoryId(m2.id);
      expect(untouched).toHaveLength(1);
    });

    it('returns 0 for empty array', async () => {
      const count = await auditRepo.deleteByMemoryIds([]);
      expect(count).toBe(0);
    });
  });
});
