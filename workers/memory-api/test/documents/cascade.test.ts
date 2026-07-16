import { describe, it, expect } from 'vitest';
import type { DataService } from '@deeprecall/worker-data';
import {
  cascadeDeleteDocumentMemories,
  listCascadeMemoryIds,
  MAX_CASCADE_MEMORIES,
} from '../../src/documents/cascade';
import { DocumentRequestError } from '../../src/documents/errors';

/**
 * Recording fake for the DATA service binding. Captures every call in
 * order so tests can assert the cascade sequence, batch sizes, and counts.
 */
function fakeData(opts: { leftoverIds?: string[]; deleteReturns?: number[] } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let listCallCount = 0;
  const deleteReturns = opts.deleteReturns ?? [];
  let deleteCallCount = 0;

  const fake = {
    calls,
    async memoryListIdsByDocumentId(_productId: string, _documentId: string, limit: number) {
      calls.push({ method: 'memoryListIdsByDocumentId', args: [_productId, _documentId, limit] });
      listCallCount++;
      // cascadeDeleteDocumentMemories takes firstPassIds directly, so its
      // only listing is the leftover safety-net check: surface the
      // configured leftovers once, then report clean.
      return listCallCount === 1 ? (opts.leftoverIds ?? []) : [];
    },
    async vectorDeleteMany(productId: string, ids: string[]) {
      calls.push({ method: 'vectorDeleteMany', args: [productId, ids] });
    },
    async auditDeleteByMemoryIds(productId: string, ids: string[]) {
      calls.push({ method: 'auditDeleteByMemoryIds', args: [productId, ids] });
      return ids.length;
    },
    async memoryDeleteByDocumentId(productId: string, documentId: string) {
      calls.push({ method: 'memoryDeleteByDocumentId', args: [productId, documentId] });
      return deleteReturns[deleteCallCount++] ?? 0;
    },
  };
  return fake;
}

const asData = (f: object) => f as unknown as Service<DataService>;

function ids(n: number, prefix = 'm'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe('cascadeDeleteDocumentMemories', () => {
  it('deletes vectors, then audits, then memory rows, in that order', async () => {
    const data = fakeData({ deleteReturns: [3] });
    const counts = await cascadeDeleteDocumentMemories(asData(data), 'p1', 'doc1', ids(3));

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'vectorDeleteMany',
      'auditDeleteByMemoryIds',
      'memoryDeleteByDocumentId',
      'memoryListIdsByDocumentId', // leftover safety-net check
    ]);
    expect(counts).toEqual({ memoriesDeleted: 3, vectorsDeleted: 3, auditsDeleted: 3 });
  });

  it('batches vector deletes at 1000 and audit deletes at 500', async () => {
    const data = fakeData({ deleteReturns: [2500] });
    await cascadeDeleteDocumentMemories(asData(data), 'p1', 'doc1', ids(2500));

    const vectorBatches = data.calls
      .filter((c) => c.method === 'vectorDeleteMany')
      .map((c) => (c.args[1] as string[]).length);
    const auditBatches = data.calls
      .filter((c) => c.method === 'auditDeleteByMemoryIds')
      .map((c) => (c.args[1] as string[]).length);

    expect(vectorBatches).toEqual([1000, 1000, 500]);
    expect(auditBatches).toEqual([500, 500, 500, 500, 500]);
  });

  it('runs a second pass over memories written by a concurrent ingestion', async () => {
    const data = fakeData({ leftoverIds: ids(2, 'late'), deleteReturns: [5, 2] });
    const counts = await cascadeDeleteDocumentMemories(asData(data), 'p1', 'doc1', ids(5));

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'vectorDeleteMany',
      'auditDeleteByMemoryIds',
      'memoryDeleteByDocumentId',
      'memoryListIdsByDocumentId',
      'vectorDeleteMany', // leftover cleanup
      'auditDeleteByMemoryIds',
      'memoryDeleteByDocumentId',
    ]);
    // Counts accumulate across both passes: 5 + 2 vectors/audits, 5 + 2 rows.
    expect(counts).toEqual({ memoriesDeleted: 7, vectorsDeleted: 7, auditsDeleted: 7 });
  });

  it('skips vector and audit deletes entirely when there is nothing linked', async () => {
    const data = fakeData({ deleteReturns: [0] });
    const counts = await cascadeDeleteDocumentMemories(asData(data), 'p1', 'doc1', []);

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual(['memoryDeleteByDocumentId', 'memoryListIdsByDocumentId']);
    expect(counts).toEqual({ memoriesDeleted: 0, vectorsDeleted: 0, auditsDeleted: 0 });
  });
});

describe('listCascadeMemoryIds', () => {
  it('lists with limit MAX_CASCADE_MEMORIES + 1 and returns the ids', async () => {
    const linked = ids(10);
    const data = {
      async memoryListIdsByDocumentId(_p: string, _d: string, limit: number) {
        expect(limit).toBe(MAX_CASCADE_MEMORIES + 1);
        return linked;
      },
    };
    await expect(listCascadeMemoryIds(asData(data), 'p1', 'doc1', 'too big')).resolves.toEqual(
      linked,
    );
  });

  it('throws CASCADE_TOO_LARGE (409) with the caller-provided message when over the cap', async () => {
    const data = {
      async memoryListIdsByDocumentId() {
        return ids(MAX_CASCADE_MEMORIES + 1);
      },
    };
    const err = await listCascadeMemoryIds(asData(data), 'p1', 'doc1', 'use the async path').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).status).toBe(409);
    expect((err as DocumentRequestError).code).toBe('CASCADE_TOO_LARGE');
    expect((err as DocumentRequestError).message).toBe('use the async path');
  });
});
