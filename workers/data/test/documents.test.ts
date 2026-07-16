import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { makeDocumentInput, makeService } from './helpers';

const data = () => env.DATA;

describe('document record facade (D1)', () => {
  it('creates, reads, updates, and deletes a document record', async () => {
    const input = makeDocumentInput({ filename: 'report.pdf', mime_type: 'application/pdf' });
    const created = await data().documentRecordCreate('default', input);
    expect(created.id).toBe(input.id);
    expect(created.filename).toBe('report.pdf');

    const updated = await data().documentRecordUpdate('default', input.id, {
      description: 'Quarterly report',
    });
    expect(updated.description).toBe('Quarterly report');

    await data().documentRecordDeleteById('default', input.id);
    expect(await data().documentRecordGetById('default', input.id)).toBeNull();
  });

  it('lists with filters and pagination', async () => {
    await data().documentRecordCreate('default', makeDocumentInput({ user_id: 'doc-user' }));
    await data().documentRecordCreate('default', makeDocumentInput({ user_id: 'doc-user' }));
    await data().documentRecordCreate('default', makeDocumentInput({ user_id: 'other' }));

    const page = await data().documentRecordList('default', { user_id: 'doc-user' }, { limit: 10 });
    expect(page.items).toHaveLength(2);
  });

  it('documentRecordDeleteByScope is strict: null user_id survives a user purge', async () => {
    await data().documentRecordCreate('default', makeDocumentInput({ user_id: 'victim' }));
    await data().documentRecordCreate(
      'default',
      makeDocumentInput({ user_id: null, agent_id: 'agent-1' }),
    );

    const deleted = await data().documentRecordDeleteByScope('default', { user_id: 'victim' });
    expect(deleted).toBe(1);

    const refs = await data().documentRecordListAllCleanupRefs('default', 10);
    expect(refs).toHaveLength(1);
  });

  it('documentRecordDeleteAll removes every record and reports the count', async () => {
    await data().documentRecordCreate('default', makeDocumentInput());
    await data().documentRecordCreate(
      'default',
      makeDocumentInput({ user_id: null, agent_id: 'a' }),
    );

    expect(await data().documentRecordDeleteAll('default')).toBe(2);
    expect(await data().documentRecordListAllCleanupRefs('default', 10)).toHaveLength(0);
  });

  it('collects cleanup refs by scope for cascade deletes', async () => {
    const doc = makeDocumentInput({ user_id: 'cascade-user' });
    await data().documentRecordCreate('default', doc);
    await data().documentRecordCreate('default', makeDocumentInput({ user_id: 'other' }));

    const refs = await data().documentRecordListCleanupRefsByScope(
      'default',
      { user_id: 'cascade-user' },
      10,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].r2_key).toBe(doc.r2_key);
  });
});

describe('R2 document storage', () => {
  const body = () => new TextEncoder().encode('hello r2').buffer as ArrayBuffer;

  it('uploads and downloads with the content type preserved', async () => {
    await data().documentUpload('default/documents/doc-1', body(), 'text/plain');

    const downloaded = await data().documentDownload('default/documents/doc-1');
    expect(downloaded).not.toBeNull();
    expect(downloaded!.contentType).toBe('text/plain');
    expect(new TextDecoder().decode(downloaded!.body)).toBe('hello r2');
  });

  it('returns null when downloading a missing key', async () => {
    expect(await data().documentDownload('default/documents/nope')).toBeNull();
  });

  it('documentDelete removes a single object', async () => {
    await data().documentUpload('default/documents/doc-2', body(), 'text/plain');
    await data().documentDelete('default/documents/doc-2');
    expect(await data().documentDownload('default/documents/doc-2')).toBeNull();
  });

  describe('documentDeleteMany', () => {
    it('returns 0 for an empty key list without touching R2', async () => {
      expect(await data().documentDeleteMany([])).toBe(0);
    });

    it('deletes all listed keys and reports the attempted count', async () => {
      const keys = ['p/a', 'p/b', 'p/c'];
      for (const key of keys) {
        await data().documentUpload(key, body(), 'text/plain');
      }

      expect(await data().documentDeleteMany(keys)).toBe(3);
      for (const key of keys) {
        expect(await data().documentDownload(key)).toBeNull();
      }
    });
  });

  describe('documentDeleteByPrefix', () => {
    it('deletes every object under the prefix and leaves other prefixes intact', async () => {
      const doomed = ['prod-a/documents/1', 'prod-a/documents/2', 'prod-a/documents/3'];
      for (const key of doomed) {
        await data().documentUpload(key, body(), 'text/plain');
      }
      await data().documentUpload('prod-b/documents/1', body(), 'text/plain');

      const deleted = await data().documentDeleteByPrefix('prod-a/');
      expect(deleted).toBe(3);

      for (const key of doomed) {
        expect(await data().documentDownload(key)).toBeNull();
      }
      expect(await data().documentDownload('prod-b/documents/1')).not.toBeNull();
    });

    it('returns 0 when nothing matches the prefix', async () => {
      expect(await data().documentDeleteByPrefix('empty-prefix/')).toBe(0);
    });

    it('follows the cursor across truncated listings and sums the count', async () => {
      // Real local R2 truncates at 1000 objects, which is too expensive to
      // seed — a stub bucket pins the cursor-threading loop instead. A bug
      // here silently strands R2 objects on large purges.
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          objects: [{ key: 'p/1' }, { key: 'p/2' }],
          truncated: true,
          cursor: 'cursor-1',
        })
        .mockResolvedValueOnce({
          objects: [{ key: 'p/3' }],
          truncated: false,
        });
      const del = vi.fn().mockResolvedValue(undefined);
      const svc = makeService({ DOCUMENTS_BUCKET: { list, delete: del } });

      expect(await svc.documentDeleteByPrefix('p/')).toBe(3);

      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[0][0]).toEqual({ prefix: 'p/', cursor: undefined });
      expect(list.mock.calls[1][0]).toEqual({ prefix: 'p/', cursor: 'cursor-1' });
      expect(del.mock.calls.map((call) => call[0])).toEqual([['p/1', 'p/2'], ['p/3']]);
    });
  });
});
