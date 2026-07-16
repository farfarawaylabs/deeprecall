import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PurgeMessage } from '@deeprecall/types';
import { runPurge, runDocumentsPurge } from '../../src/jobs/purge';

function makeMockData() {
  return {
    memoryListIdsByScopeStrict: vi.fn().mockResolvedValue([]),
    memoryListAllIds: vi.fn().mockResolvedValue([]),
    memoryListIdsByDocumentId: vi.fn().mockResolvedValue([]),
    memoryListIdsWithAnyDocument: vi.fn().mockResolvedValue([]),
    memoryDeleteByScope: vi.fn().mockResolvedValue(0),
    memoryDeleteAll: vi.fn().mockResolvedValue(0),
    memoryDeleteByDocumentId: vi.fn().mockResolvedValue(0),
    memoryDeleteAllWithDocument: vi.fn().mockResolvedValue(0),
    vectorDeleteMany: vi.fn().mockResolvedValue(undefined),
    auditDeleteByMemoryIds: vi.fn().mockResolvedValue(0),
    documentRecordListCleanupRefsByScope: vi.fn().mockResolvedValue([]),
    documentRecordListAllCleanupRefs: vi.fn().mockResolvedValue([]),
    documentRecordDeleteByScope: vi.fn().mockResolvedValue(0),
    documentRecordDeleteAll: vi.fn().mockResolvedValue(0),
    documentDeleteMany: vi.fn().mockResolvedValue(0),
    documentDeleteByPrefix: vi.fn().mockResolvedValue(0),
  } as any;
}

function makeMockKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as any;
}

describe('runDocumentsPurge', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    data = makeMockData();
  });

  describe('scoped', () => {
    it('forwards user_id scope to cleanup-refs + delete-by-scope', async () => {
      data.documentRecordListCleanupRefsByScope.mockResolvedValue([
        { id: 'doc-1', r2_key: 'default/documents/doc-1/a.pdf' },
      ]);
      // First-pass returns two IDs, second-pass (safety net) returns empty —
      // the common case where no concurrent ingestion raced the purge.
      data.memoryListIdsByDocumentId
        .mockResolvedValueOnce(['m-1', 'm-2'])
        .mockResolvedValueOnce([]);
      data.memoryDeleteByDocumentId.mockResolvedValue(2);
      data.documentDeleteMany.mockResolvedValue(1);
      data.documentRecordDeleteByScope.mockResolvedValue(1);

      const result = await runDocumentsPurge('default', { user_id: 'user-X' }, data);

      expect(data.documentRecordListCleanupRefsByScope).toHaveBeenCalledWith(
        'default',
        { user_id: 'user-X', agent_id: undefined },
        expect.any(Number),
      );
      expect(data.vectorDeleteMany).toHaveBeenCalledWith('default', ['m-1', 'm-2']);
      expect(data.memoryDeleteByDocumentId).toHaveBeenCalledWith('default', 'doc-1');
      expect(data.documentDeleteMany).toHaveBeenCalledWith(['default/documents/doc-1/a.pdf']);
      expect(data.documentRecordDeleteByScope).toHaveBeenCalledWith('default', {
        user_id: 'user-X',
        agent_id: undefined,
      });
      expect(result).toMatchObject({
        documents_deleted: 1,
        memories_deleted: 2,
        r2_blobs_deleted: 1,
      });
    });

    it('safety net catches concurrently-written memories and cleans their vectors', async () => {
      data.documentRecordListCleanupRefsByScope.mockResolvedValue([
        { id: 'doc-1', r2_key: 'default/documents/doc-1/a.pdf' },
      ]);
      // First pass: two IDs. SQL delete nukes them. Between the listing and
      // the delete a concurrent ingestion wrote m-3 — its D1 row is also
      // gone, but its vector is still live. Second pass surfaces m-3.
      data.memoryListIdsByDocumentId
        .mockResolvedValueOnce(['m-1', 'm-2'])
        .mockResolvedValueOnce(['m-3']);
      data.memoryDeleteByDocumentId.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
      data.documentRecordDeleteByScope.mockResolvedValue(1);
      // Short-circuit check compares list length, so we need a non-empty array.

      const result = await runDocumentsPurge('default', { user_id: 'user-Z' }, data);

      // Both first-pass and leftover m-3 vector deletes should have fired.
      expect(data.vectorDeleteMany).toHaveBeenCalledTimes(2);
      expect(data.vectorDeleteMany).toHaveBeenNthCalledWith(1, 'default', ['m-1', 'm-2']);
      expect(data.vectorDeleteMany).toHaveBeenNthCalledWith(2, 'default', ['m-3']);
      // memories_deleted reflects both cascade rounds (2 + 0 on second).
      expect(result.memories_deleted).toBe(2);
    });

    it('forwards agent-only scope as-is (no agent: prefix encoding)', async () => {
      data.documentRecordListCleanupRefsByScope.mockResolvedValue([]);

      await runDocumentsPurge('default', { agent_id: 'agent-Y' }, data);

      expect(data.documentRecordListCleanupRefsByScope).toHaveBeenCalledWith(
        'default',
        { user_id: undefined, agent_id: 'agent-Y' },
        expect.any(Number),
      );
    });

    it('short-circuits when no docs match the scope', async () => {
      data.documentRecordListCleanupRefsByScope.mockResolvedValue([]);

      const result = await runDocumentsPurge('default', { user_id: 'no-docs' }, data);

      expect(result).toEqual({
        memories_deleted: 0,
        vectors_deleted: 0,
        audits_deleted: 0,
        documents_deleted: 0,
        r2_blobs_deleted: 0,
      });
      expect(data.vectorDeleteMany).not.toHaveBeenCalled();
      expect(data.memoryDeleteByDocumentId).not.toHaveBeenCalled();
      expect(data.documentDeleteMany).not.toHaveBeenCalled();
    });
  });

  describe('product-wide (no scope)', () => {
    it('uses prefix R2 delete and deleteAllWithDocument for memories', async () => {
      // First pass: three IDs. Safety-net second pass: empty (no race).
      data.memoryListIdsWithAnyDocument
        .mockResolvedValueOnce(['m-1', 'm-2', 'm-3'])
        .mockResolvedValueOnce([]);
      data.memoryDeleteAllWithDocument.mockResolvedValue(3);
      data.documentDeleteByPrefix.mockResolvedValue(7);
      data.documentRecordDeleteAll.mockResolvedValue(5);

      const result = await runDocumentsPurge('tenant-A', undefined, data);

      expect(data.memoryListIdsWithAnyDocument).toHaveBeenCalledWith(
        'tenant-A',
        expect.any(Number),
      );
      expect(data.memoryDeleteAllWithDocument).toHaveBeenCalledWith('tenant-A');
      expect(data.documentDeleteByPrefix).toHaveBeenCalledWith('tenant-A/documents/');
      expect(data.documentRecordDeleteAll).toHaveBeenCalledWith('tenant-A');
      expect(result).toMatchObject({
        memories_deleted: 3,
        documents_deleted: 5,
        r2_blobs_deleted: 7,
      });
    });

    it('skips memory cascade when memoriesAlreadyWiped is true', async () => {
      data.documentDeleteByPrefix.mockResolvedValue(2);
      data.documentRecordDeleteAll.mockResolvedValue(2);

      const result = await runDocumentsPurge('tenant-B', undefined, data, {
        memoriesAlreadyWiped: true,
      });

      expect(data.memoryListIdsWithAnyDocument).not.toHaveBeenCalled();
      expect(data.memoryDeleteAllWithDocument).not.toHaveBeenCalled();
      expect(data.vectorDeleteMany).not.toHaveBeenCalled();
      expect(result.memories_deleted).toBe(0);
      expect(result.documents_deleted).toBe(2);
      expect(result.r2_blobs_deleted).toBe(2);
    });
  });
});

describe('runPurge dispatching', () => {
  let data: ReturnType<typeof makeMockData>;
  let kv: ReturnType<typeof makeMockKv>;

  const baseJob = {
    kind: 'purge' as const,
    job_id: 'job-1',
    product_id: 'default',
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    data = makeMockData();
    kv = makeMockKv();
    kv.store.set(
      'purge_job:default:job-1',
      JSON.stringify({
        job_id: 'job-1',
        product_id: 'default',
        type: 'purge_scoped',
        status: 'pending',
        scope: null,
        memories_deleted: 0,
        vectors_deleted: 0,
        audits_deleted: 0,
        documents_deleted: 0,
        r2_blobs_deleted: 0,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        error: null,
      }),
    );
  });

  it('purge_product leaves documents alone by default', async () => {
    data.memoryDeleteAll.mockResolvedValue(10);

    const msg: PurgeMessage = { ...baseJob, type: 'purge_product' };
    const result = await runPurge(msg, data, kv);

    expect(data.memoryDeleteAll).toHaveBeenCalledWith('default');
    // No doc/R2 cascade without opt-in.
    expect(data.documentDeleteByPrefix).not.toHaveBeenCalled();
    expect(data.documentRecordDeleteAll).not.toHaveBeenCalled();
    expect(result.documents_deleted).toBe(0);
    expect(result.r2_blobs_deleted).toBe(0);
    expect(result.memories_deleted).toBe(10);
  });

  it('purge_product cascades into documents when include_documents=true', async () => {
    data.memoryDeleteAll.mockResolvedValue(10);
    data.documentDeleteByPrefix.mockResolvedValue(3);
    data.documentRecordDeleteAll.mockResolvedValue(2);

    const msg: PurgeMessage = {
      ...baseJob,
      type: 'purge_product',
      include_documents: true,
    };
    const result = await runPurge(msg, data, kv);

    expect(data.memoryDeleteAll).toHaveBeenCalledWith('default');
    // The docs helper runs with memoriesAlreadyWiped=true so it skips the
    // memory-side cascade entirely.
    expect(data.memoryDeleteAllWithDocument).not.toHaveBeenCalled();
    expect(data.documentDeleteByPrefix).toHaveBeenCalledWith('default/documents/');
    expect(data.documentRecordDeleteAll).toHaveBeenCalledWith('default');
    expect(result.documents_deleted).toBe(2);
    expect(result.r2_blobs_deleted).toBe(3);
    expect(result.memories_deleted).toBe(10);
  });

  it('purge_documents_scoped routes to runDocumentsPurge with scope', async () => {
    data.documentRecordListCleanupRefsByScope.mockResolvedValue([]);

    const msg: PurgeMessage = {
      ...baseJob,
      type: 'purge_documents_scoped',
      scope: { user_id: 'u-1' },
    };
    await runPurge(msg, data, kv);

    expect(data.documentRecordListCleanupRefsByScope).toHaveBeenCalledWith(
      'default',
      { user_id: 'u-1', agent_id: undefined },
      expect.any(Number),
    );
  });

  it('purge_documents_all routes to runDocumentsPurge with no scope', async () => {
    data.documentRecordDeleteAll.mockResolvedValue(0);

    const msg: PurgeMessage = {
      ...baseJob,
      type: 'purge_documents_all',
    };
    await runPurge(msg, data, kv);

    expect(data.documentDeleteByPrefix).toHaveBeenCalledWith('default/documents/');
  });

  it('throws on purge_documents_scoped without scope', async () => {
    const msg: PurgeMessage = {
      ...baseJob,
      type: 'purge_documents_scoped',
    };
    await expect(runPurge(msg, data, kv)).rejects.toThrow(/missing scope/);
  });

  it('persists documents_deleted and r2_blobs_deleted to job status', async () => {
    data.documentDeleteByPrefix.mockResolvedValue(4);
    data.documentRecordDeleteAll.mockResolvedValue(6);

    const msg: PurgeMessage = {
      ...baseJob,
      type: 'purge_documents_all',
    };
    await runPurge(msg, data, kv);

    const stored = JSON.parse(kv.store.get('purge_job:default:job-1')!);
    expect(stored.status).toBe('completed');
    expect(stored.documents_deleted).toBe(6);
    expect(stored.r2_blobs_deleted).toBe(4);
  });

  it('propagates downstream failures so the queue consumer can retry', async () => {
    data.memoryDeleteAll.mockRejectedValue(new Error('d1 timeout'));

    const msg: PurgeMessage = { ...baseJob, type: 'purge_product' };
    await expect(runPurge(msg, data, kv)).rejects.toThrow(/d1 timeout/);

    // Status should reflect that the job entered processing before failing,
    // so the retry loop has a chance to pick up where it left off.
    const stored = JSON.parse(kv.store.get('purge_job:default:job-1')!);
    expect(stored.status).toBe('processing');
  });
});
