import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { makeMemoryInput, makeDeadLetter, makeService } from './helpers';

// Happy-path calls go through the DATA self-service binding, exercising the
// same RPC path production workers use. Expected-rejection tests use direct
// construction instead: a promise rejected over RPC also surfaces as an
// unhandled rejection on the remote side, which vitest reports as an error.
const data = () => env.DATA;

describe('binding resolution', () => {
  it('rejects D1 access for an unknown product with a descriptive error', async () => {
    await expect(makeService().memoryGetById('ghost-product', 'mem-1')).rejects.toThrow(
      'No D1 binding found for product "ghost-product" (expected binding "DB_ghost-product")',
    );
  });

  it('rejects Vectorize access for an unknown product with a descriptive error', async () => {
    await expect(makeService().vectorDelete('ghost-product', 'mem-1')).rejects.toThrow(
      'No Vectorize binding found for product "ghost-product" (expected binding "VEC_ghost-product")',
    );
  });
});

describe('memory facade over RPC', () => {
  it('creates and reads back a memory through real D1', async () => {
    const input = makeMemoryInput({ tags: ['preference'] });
    const created = await data().memoryCreate('default', input);
    expect(created.id).toBe(input.id);
    expect(created.tags).toEqual(['preference']);

    const fetched = await data().memoryGetById('default', input.id);
    expect(fetched?.content).toBe(input.content);
    expect(fetched?.user_id).toBe('user-1');
  });

  it('lists by scope with pagination metadata', async () => {
    await data().memoryCreate('default', makeMemoryInput({ user_id: 'scoped-user' }));
    await data().memoryCreate('default', makeMemoryInput({ user_id: 'scoped-user' }));
    await data().memoryCreate('default', makeMemoryInput({ user_id: 'other-user' }));

    const page = await data().memoryListByScope(
      'default',
      { user_id: 'scoped-user' },
      { limit: 10 },
    );
    expect(page.items).toHaveLength(2);
    expect(page.cursor).toBeNull();
  });

  describe('memoryDeleteByScope (strict match)', () => {
    it('deletes only rows whose user_id equals the scope; null does not match', async () => {
      await data().memoryCreate('default', makeMemoryInput({ user_id: 'victim' }));
      await data().memoryCreate('default', makeMemoryInput({ user_id: 'victim' }));
      await data().memoryCreate('default', makeMemoryInput({ user_id: 'bystander' }));
      // Standalone-agent memory: user_id null must survive a user-scoped purge.
      await data().memoryCreate('default', makeMemoryInput({ user_id: null, agent_id: 'agent-1' }));

      // D1 meta.changes may include FTS trigger operations, so >= not ===.
      const deleted = await data().memoryDeleteByScope('default', { user_id: 'victim' });
      expect(deleted).toBeGreaterThanOrEqual(2);

      const survivors = await data().memoryListAllIds('default', 100);
      expect(survivors).toHaveLength(2);

      // Strict scope listing: exactly the bystander row, and exactly the
      // standalone-agent row — the null-user memory survived the user purge.
      expect(
        await data().memoryListIdsByScopeStrict('default', { user_id: 'bystander' }, 10),
      ).toHaveLength(1);
      expect(
        await data().memoryListIdsByScopeStrict('default', { agent_id: 'agent-1' }, 10),
      ).toHaveLength(1);
    });

    it('rejects an empty scope instead of deleting everything', async () => {
      await data().memoryCreate('default', makeMemoryInput());
      await expect(makeService().memoryDeleteByScope('default', {})).rejects.toThrow(
        /at least one of user_id or agent_id/,
      );
      expect(await data().memoryListAllIds('default', 10)).toHaveLength(1);
    });
  });

  describe('memoryDeleteAll', () => {
    it('deletes every memory regardless of scope or status and reports the count', async () => {
      await data().memoryCreate('default', makeMemoryInput({ user_id: 'u1' }));
      await data().memoryCreate('default', makeMemoryInput({ user_id: null, agent_id: 'a1' }));
      await data().memoryCreate('default', makeMemoryInput({ status: 'superseded' }));

      // D1 meta.changes may include FTS trigger operations, so >= not ===.
      const deleted = await data().memoryDeleteAll('default');
      expect(deleted).toBeGreaterThanOrEqual(3);
      expect(await data().memoryListAllIds('default', 10)).toHaveLength(0);
    });
  });

  describe('memoryDeleteByDocumentId', () => {
    it('deletes only memories tied to the document', async () => {
      const docId = crypto.randomUUID();
      await data().memoryCreate('default', makeMemoryInput({ document_id: docId }));
      await data().memoryCreate('default', makeMemoryInput({ document_id: docId }));
      await data().memoryCreate('default', makeMemoryInput({ document_id: null }));

      const ids = await data().memoryListIdsByDocumentId('default', docId, 100);
      expect(ids).toHaveLength(2);

      // D1 meta.changes may include FTS trigger operations, so >= not ===.
      const deleted = await data().memoryDeleteByDocumentId('default', docId);
      expect(deleted).toBeGreaterThanOrEqual(2);
      expect(await data().memoryListAllIds('default', 10)).toHaveLength(1);
    });
  });

  describe('memoryDeleteAllWithDocument', () => {
    it('deletes every doc-linked memory in one pass; unlinked memories survive', async () => {
      await data().memoryCreate('default', makeMemoryInput({ document_id: crypto.randomUUID() }));
      await data().memoryCreate('default', makeMemoryInput({ document_id: crypto.randomUUID() }));
      const unlinked = makeMemoryInput({ document_id: null });
      await data().memoryCreate('default', unlinked);

      expect(await data().memoryListIdsWithAnyDocument('default', 100)).toHaveLength(2);

      // D1 meta.changes may include FTS trigger operations, so >= not ===.
      const deleted = await data().memoryDeleteAllWithDocument('default');
      expect(deleted).toBeGreaterThanOrEqual(2);
      expect(await data().memoryListAllIds('default', 10)).toEqual([unlinked.id]);
    });
  });

  it('FTS search finds created memories and respects deletion', async () => {
    const input = makeMemoryInput({ content: 'Enjoys quantum chromodynamics lectures' });
    await data().memoryCreate('default', input);

    const hits = await data().memorySearch('default', 'chromodynamics', { user_id: 'user-1' }, 10);
    expect(hits.map((m) => m.id)).toContain(input.id);

    // The FTS index must follow the delete (AFTER DELETE trigger).
    await data().memoryDeleteByScope('default', { user_id: 'user-1' });
    const after = await data().memorySearch('default', 'chromodynamics', { user_id: 'user-1' }, 10);
    expect(after).toHaveLength(0);
  });
});

describe('idempotency facade', () => {
  it('stores and replays a response, and misses on unknown keys', async () => {
    expect(await data().idempotencyCheck('default', 'key-1')).toBeNull();

    await data().idempotencyStore('default', 'key-1', '{"result":"cached"}', 24);
    expect(await data().idempotencyCheck('default', 'key-1')).toBe('{"result":"cached"}');
  });
});

describe('audit facade', () => {
  it('logs and reads back entries, then deletes by memory ids', async () => {
    const memoryId = crypto.randomUUID();
    await data().auditLog(
      'default',
      'created',
      memoryId,
      'test reason',
      null,
      { content: 'new' },
      'api',
    );

    const entries = await data().auditGetByMemoryId('default', memoryId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('created');

    const deleted = await data().auditDeleteByMemoryIds('default', [memoryId]);
    expect(deleted).toBe(1);
    expect(await data().auditGetByMemoryId('default', memoryId)).toHaveLength(0);
  });
});

describe('dead letter facade', () => {
  it('supports the full create/get/list/count/delete lifecycle', async () => {
    const entry = makeDeadLetter();
    await data().deadLetterCreate('default', entry);

    expect(await data().deadLetterCount('default')).toBe(1);
    const fetched = await data().deadLetterGetById('default', entry.id);
    expect(fetched?.queue_name).toBe('ingestion-queue');
    expect(await data().deadLetterList('default', 10)).toHaveLength(1);

    await data().deadLetterDeleteById('default', entry.id);
    expect(await data().deadLetterCount('default')).toBe(0);
  });
});
