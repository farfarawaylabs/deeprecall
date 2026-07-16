import { describe, it, expect } from 'vitest';
import type { Document } from '@deeprecall/types';
import {
  assertDocumentIngestionEnabled,
  deleteDocument,
  getDocumentOrThrow,
  replaceDocument,
  uploadDocument,
  type DocumentsContext,
} from '../../src/documents/documents-service';
import { DocumentRequestError } from '../../src/documents/errors';
import type { ParsedDocumentUpload } from '../../src/documents/multipart';

// ─── Fakes ───────────────────────────────────────────────────

interface Call {
  method: string;
  args: unknown[];
}

/** Recording fake covering every DATA method the documents service touches. */
function fakeData(opts: { existing?: Document | null; linkedIds?: string[] } = {}) {
  const calls: Call[] = [];
  let listCalls = 0;
  return {
    calls,
    async documentRecordGetById() {
      calls.push({ method: 'documentRecordGetById', args: [] });
      return opts.existing ?? null;
    },
    async documentUpload(key: string, body: ArrayBuffer, contentType: string) {
      calls.push({ method: 'documentUpload', args: [key, body, contentType] });
    },
    async documentRecordCreate(productId: string, input: unknown) {
      calls.push({ method: 'documentRecordCreate', args: [productId, input] });
      return input as Document;
    },
    async documentRecordUpdate(productId: string, id: string, input: unknown) {
      calls.push({ method: 'documentRecordUpdate', args: [productId, id, input] });
      return input as Document;
    },
    async documentRecordDeleteById(productId: string, id: string) {
      calls.push({ method: 'documentRecordDeleteById', args: [productId, id] });
    },
    async documentDelete(key: string) {
      calls.push({ method: 'documentDelete', args: [key] });
    },
    async memoryListIdsByDocumentId() {
      calls.push({ method: 'memoryListIdsByDocumentId', args: [] });
      listCalls++;
      // First call: the pre-cascade listing. Later calls: leftover check.
      return listCalls === 1 ? (opts.linkedIds ?? []) : [];
    },
    async vectorDeleteMany(_p: string, ids: string[]) {
      calls.push({ method: 'vectorDeleteMany', args: [ids] });
    },
    async auditDeleteByMemoryIds(_p: string, ids: string[]) {
      calls.push({ method: 'auditDeleteByMemoryIds', args: [ids] });
      return ids.length;
    },
    async memoryDeleteByDocumentId() {
      calls.push({ method: 'memoryDeleteByDocumentId', args: [] });
      return (opts.linkedIds ?? []).length;
    },
  };
}

/** Fake INGESTION service binding recording each /ingest request. */
function fakeIngestion(opts: { fail?: boolean } = {}) {
  const requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let n = 0;
  return {
    requests,
    async fetch(req: Request) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      // The real ingestion worker always answers JSON, success or error —
      // and ingestChunks parses the body unconditionally, so the fake must
      // stay JSON too.
      if (opts.fail) {
        return Response.json(
          { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
          { status: 500 },
        );
      }
      n++;
      return Response.json({ instance_id: `wf-${n}` });
    },
  };
}

function fakeCtx(overrides: {
  data?: object;
  ingestion?: object;
  config?: string | null;
}): DocumentsContext {
  const env = {
    DATA: overrides.data ?? fakeData(),
    INGESTION: overrides.ingestion ?? fakeIngestion(),
    CONFIG: {
      async get() {
        return overrides.config ?? null;
      },
    },
    INTERNAL_SERVICE_KEY: 'internal-test-key',
  };
  return { env: env as unknown as Env, productId: 'p1', traceId: 'trace-1' };
}

function parsedUpload(overrides: Partial<ParsedDocumentUpload> = {}): ParsedDocumentUpload {
  return {
    file: new File(['hello world'], 'a.txt', { type: 'text/plain' }),
    scope: { user_id: 'u1' },
    documentType: 'transcript',
    description: 'desc',
    sceneType: 'document',
    idempotencyKey: undefined,
    fileType: 'text',
    r2Buffer: new TextEncoder().encode('hello world').buffer as ArrayBuffer,
    textContent: 'hello world',
    ...overrides,
  };
}

function existingDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    r2_key: 'p1/documents/doc-1/old.txt',
    filename: 'old.txt',
    mime_type: 'text/plain',
    size_bytes: 10,
    file_type: 'text',
    document_type: 'old-type',
    description: 'old-desc',
    user_id: 'u1',
    agent_id: null,
    session_id: null,
    uploaded_at: '2026-01-01T00:00:00.000Z',
    metadata: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('assertDocumentIngestionEnabled', () => {
  it('passes when the product has no stored config', async () => {
    await expect(assertDocumentIngestionEnabled(fakeCtx({}))).resolves.toBeUndefined();
  });

  it('passes when the feature flag is absent or true', async () => {
    await expect(
      assertDocumentIngestionEnabled(fakeCtx({ config: JSON.stringify({ features: {} }) })),
    ).resolves.toBeUndefined();
    await expect(
      assertDocumentIngestionEnabled(
        fakeCtx({ config: JSON.stringify({ features: { document_ingestion: true } }) }),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws FEATURE_DISABLED (403) when the flag is explicitly false', async () => {
    const err = await assertDocumentIngestionEnabled(
      fakeCtx({ config: JSON.stringify({ features: { document_ingestion: false } }) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).status).toBe(403);
    expect((err as DocumentRequestError).code).toBe('FEATURE_DISABLED');
    expect((err as DocumentRequestError).message).toBe(
      'Document ingestion is not enabled for this product',
    );
  });
});

describe('getDocumentOrThrow', () => {
  it('throws NOT_FOUND (404) with the document id in the message', async () => {
    const err = await getDocumentOrThrow(fakeCtx({}), 'missing-doc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).status).toBe(404);
    expect((err as DocumentRequestError).code).toBe('NOT_FOUND');
    expect((err as DocumentRequestError).message).toBe('Document missing-doc not found');
  });

  it('returns the document when found', async () => {
    const doc = existingDoc();
    const ctx = fakeCtx({ data: fakeData({ existing: doc }) });
    await expect(getDocumentOrThrow(ctx, 'doc-1')).resolves.toEqual(doc);
  });
});

describe('uploadDocument', () => {
  it('uploads to R2, creates the record, ingests, and returns the 202 body', async () => {
    const data = fakeData();
    const ingestion = fakeIngestion();
    const ctx = fakeCtx({ data, ingestion });

    const result = await uploadDocument(parsedUpload(), ctx);

    // R2 key: <product>/documents/<uuid>/<filename>
    const uploadCall = data.calls.find((c) => c.method === 'documentUpload')!;
    expect(uploadCall.args[0]).toMatch(/^p1\/documents\/[0-9a-f-]{36}\/a\.txt$/);
    expect(uploadCall.args[2]).toBe('text/plain');

    // D1 record stamped with the full scope + resolved file type.
    const createCall = data.calls.find((c) => c.method === 'documentRecordCreate')!;
    expect(createCall.args[0]).toBe('p1');
    expect(createCall.args[1]).toMatchObject({
      filename: 'a.txt',
      mime_type: 'text/plain',
      file_type: 'text',
      document_type: 'transcript',
      description: 'desc',
      user_id: 'u1',
      agent_id: null,
      session_id: null,
      metadata: null,
    });

    // Ingestion fan-out carries the internal auth header and trace id.
    expect(ingestion.requests).toHaveLength(1);
    expect(ingestion.requests[0]!.headers['x-internal-key']).toBe('internal-test-key');
    expect(ingestion.requests[0]!.headers['x-trace-id']).toBe('trace-1');
    expect(ingestion.requests[0]!.body).toMatchObject({
      product_id: 'p1',
      content: 'hello world',
      scope: { user_id: 'u1' },
      source_channel: 'document',
      scene_type: 'document',
    });
    expect(ingestion.requests[0]!.body.idempotency_key).toBeUndefined();

    expect(result).toEqual({
      document_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      instance_id: 'wf-1',
      instance_ids: ['wf-1'],
      chunks: 1,
      filename: 'a.txt',
      size_bytes: 11,
      message: 'Document uploaded and 1 chunk(s) sent for ingestion',
    });
  });

  it('suffixes the idempotency key per chunk', async () => {
    const ingestion = fakeIngestion();
    const ctx = fakeCtx({ ingestion });
    await uploadDocument(parsedUpload({ idempotencyKey: 'idem-9' }), ctx);
    expect(ingestion.requests[0]!.body.idempotency_key).toBe('idem-9:chunk-0');
  });

  it('stores the idempotency key in record metadata when present', async () => {
    const data = fakeData();
    await uploadDocument(parsedUpload({ idempotencyKey: 'idem-9' }), fakeCtx({ data }));
    const createCall = data.calls.find((c) => c.method === 'documentRecordCreate')!;
    expect(createCall.args[1]).toMatchObject({ metadata: { idempotency_key: 'idem-9' } });
  });

  it('throws INGESTION_ERROR (502) when no chunk starts ingestion', async () => {
    const ctx = fakeCtx({ ingestion: fakeIngestion({ fail: true }) });
    const err = await uploadDocument(parsedUpload(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).status).toBe(502);
    expect((err as DocumentRequestError).code).toBe('INGESTION_ERROR');
    expect((err as DocumentRequestError).message).toBe(
      'Document uploaded but ingestion failed to start',
    );
  });
});

describe('replaceDocument', () => {
  it('orders the flow: new blob, row update, cascade, old blob delete, ingest', async () => {
    const data = fakeData({ existing: existingDoc(), linkedIds: ['m1', 'm2'] });
    const ingestion = fakeIngestion();
    const ctx = fakeCtx({ data, ingestion });

    const result = await replaceDocument(existingDoc(), parsedUpload(), ctx);

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'memoryListIdsByDocumentId', // oversize pre-check
      'documentUpload', // 1. new blob first
      'documentRecordUpdate', // 2. row points at new blob
      'vectorDeleteMany', // 3. cascade: vectors
      'auditDeleteByMemoryIds', //    audits
      'memoryDeleteByDocumentId', //    memory rows
      'memoryListIdsByDocumentId', //    leftover safety net
      'documentDelete', // 4. old blob last
    ]);

    // New key is revision-scoped: <product>/documents/<doc>/<timestamp>-<name>
    const uploadCall = data.calls.find((c) => c.method === 'documentUpload')!;
    expect(uploadCall.args[0]).toMatch(/^p1\/documents\/doc-1\/\d+-a\.txt$/);

    // Old blob (different key) removed.
    const deleteCall = data.calls.find((c) => c.method === 'documentDelete')!;
    expect(deleteCall.args[0]).toBe('p1/documents/doc-1/old.txt');

    expect(result).toEqual({
      document_id: 'doc-1',
      instance_id: 'wf-1',
      instance_ids: ['wf-1'],
      chunks: 1,
      filename: 'a.txt',
      size_bytes: 11,
      old_memories_deleted: 2,
      old_vectors_deleted: 2,
      old_audits_deleted: 2,
      message: 'Document replaced and 1 chunk(s) sent for ingestion',
    });
  });

  it('rejects oversize cascades before touching any state', async () => {
    const linked = Array.from({ length: 5001 }, (_, i) => `m${i}`);
    const data = fakeData({ existing: existingDoc(), linkedIds: linked });
    const ctx = fakeCtx({ data });

    const err = await replaceDocument(existingDoc(), parsedUpload(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).code).toBe('CASCADE_TOO_LARGE');
    expect((err as DocumentRequestError).message).toBe(
      'Document has more than 5000 linked memories; delete + re-upload explicitly via the async purge endpoint',
    );
    // Nothing destructive ran: only the listing.
    expect(data.calls.map((c) => c.method)).toEqual(['memoryListIdsByDocumentId']);
  });

  it('throws INGESTION_ERROR (502) with the replace-specific message', async () => {
    const data = fakeData({ existing: existingDoc() });
    const ctx = fakeCtx({ data, ingestion: fakeIngestion({ fail: true }) });
    const err = await replaceDocument(existingDoc(), parsedUpload(), ctx).catch((e: unknown) => e);
    expect((err as DocumentRequestError).message).toBe(
      'Document replaced but ingestion failed to start',
    );
  });
});

describe('deleteDocument', () => {
  it('throws NOT_FOUND for a missing document', async () => {
    const err = await deleteDocument('nope', fakeCtx({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentRequestError);
    expect((err as DocumentRequestError).code).toBe('NOT_FOUND');
  });

  it('cascades, deletes the blob, then the row, and returns counts', async () => {
    const data = fakeData({ existing: existingDoc(), linkedIds: ['m1', 'm2', 'm3'] });
    const ctx = fakeCtx({ data });

    const result = await deleteDocument('doc-1', ctx);

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'documentRecordGetById',
      'memoryListIdsByDocumentId',
      'vectorDeleteMany',
      'auditDeleteByMemoryIds',
      'memoryDeleteByDocumentId',
      'memoryListIdsByDocumentId', // leftover safety net
      'documentDelete', // R2 blob
      'documentRecordDeleteById', // row last
    ]);

    expect(result).toEqual({
      deleted: true,
      document_id: 'doc-1',
      memories_deleted: 3,
      vectors_deleted: 3,
      audits_deleted: 3,
    });
  });

  it('rejects oversize cascades with the delete-specific message', async () => {
    const linked = Array.from({ length: 5001 }, (_, i) => `m${i}`);
    const data = fakeData({ existing: existingDoc(), linkedIds: linked });
    const err = await deleteDocument('doc-1', fakeCtx({ data })).catch((e: unknown) => e);
    expect((err as DocumentRequestError).code).toBe('CASCADE_TOO_LARGE');
    expect((err as DocumentRequestError).message).toBe(
      'Document has more than 5000 linked memories; use POST /v1/memories/purge or DELETE /v1/documents with scope for async processing',
    );
  });
});
