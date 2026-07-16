/**
 * Document pipeline over REAL local D1 + REAL local R2.
 *
 * The mock-based suite in documents-service.test.ts pins call ordering
 * against a recording fake; this suite proves the same orchestration against
 * real storage: uploadDocument writes an actual R2 object and D1 row, the
 * delete/replace cascades remove exactly the linked memories, audits, FTS
 * entries, blobs, and rows - and nothing belonging to any other document.
 *
 * Stubbed boundaries (nothing else):
 *   - Vectorize (no miniflare simulator): stubbed at the raw binding level
 *     (VEC_default.deleteByIds), so the real CloudflareVectorizeService
 *     batching code still runs.
 *   - INGESTION service binding (cross-worker): a recording fetch fake, so
 *     the fan-out payloads and internal-auth headers are asserted here.
 */
import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
// Applies migrations and registers the per-test table wipe (see file header).
import '../apply-migrations';
import type { MemoryCreateInput } from '@deeprecall/db';
import { DataService } from '@deeprecall/worker-data';
import {
  deleteDocument,
  replaceDocument,
  uploadDocument,
  type DocumentsContext,
} from '../../src/documents/documents-service';
import type { ParsedDocumentUpload } from '../../src/documents/multipart';

const PRODUCT_ID = 'default';

type DataEnv = ConstructorParameters<typeof DataService>[1];

function makeHarness() {
  // Stub ONLY the raw Vectorize binding - CloudflareVectorizeService (with
  // its 100-id batching) still runs for real above it.
  const deleteByIds = vi.fn().mockResolvedValue(undefined);

  const service = new DataService(createExecutionContext(), {
    DB_default: env.DB_default,
    DOCUMENTS_BUCKET: env.DOCUMENTS_BUCKET,
    VEC_default: { deleteByIds },
  } as DataEnv);

  // Recording INGESTION fake: the real worker always answers JSON.
  const ingestionRequests: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  let instanceCounter = 0;
  const ingestion = {
    async fetch(req: Request) {
      const body = (await req.json()) as Record<string, unknown>;
      ingestionRequests.push({ headers: Object.fromEntries(req.headers.entries()), body });
      instanceCounter++;
      return Response.json({ instance_id: `wf-${instanceCounter}` });
    },
  };

  const ctx: DocumentsContext = {
    env: {
      DATA: service,
      INGESTION: ingestion,
      CONFIG: {
        async get() {
          return null;
        },
      },
      INTERNAL_SERVICE_KEY: 'internal-test-key',
    } as unknown as Env,
    productId: PRODUCT_ID,
    traceId: 'trace-doc-int',
  };

  return { service, ctx, deleteByIds, ingestionRequests };
}

function parsedUpload(
  content: string,
  filename: string,
  overrides: Partial<ParsedDocumentUpload> = {},
): ParsedDocumentUpload {
  return {
    file: new File([content], filename, { type: 'text/plain' }),
    scope: { user_id: 'user-doc' },
    documentType: 'notes',
    description: 'integration fixture',
    sceneType: 'document',
    idempotencyKey: undefined,
    fileType: 'text',
    r2Buffer: new TextEncoder().encode(content).buffer as ArrayBuffer,
    textContent: content,
    ...overrides,
  };
}

function makeMemoryInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'placeholder',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-doc',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'document',
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

/**
 * Simulate what the ingestion pipeline persists for a document chunk: a
 * memory row linked via document_id plus its `created` audit entry. The FK
 * on document_id means the document row MUST exist first (upload before
 * seed) - same ordering constraint production hits.
 */
async function seedLinkedMemory(service: DataService, documentId: string, content: string) {
  const memory = await service.memoryCreate(
    PRODUCT_ID,
    makeMemoryInput({ document_id: documentId, content }),
  );
  await service.auditLog(
    PRODUCT_ID,
    'created',
    memory.id,
    'seed',
    null,
    memory,
    'ingestion_pipeline',
  );
  return memory;
}

describe('document upload over real D1 + R2', () => {
  it('stores the blob in R2, the scoped record in D1, and fans out ingestion', async () => {
    const { service, ctx, ingestionRequests } = makeHarness();
    const content = 'The quarterly report says revenue doubled in Lisbon.';

    const result = await uploadDocument(parsedUpload(content, 'report.txt'), ctx);

    expect(result).toEqual({
      document_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      instance_id: 'wf-1',
      instance_ids: ['wf-1'],
      chunks: 1,
      filename: 'report.txt',
      size_bytes: content.length,
      message: 'Document uploaded and 1 chunk(s) sent for ingestion',
    });

    // Real D1 row, stamped with the upload scope.
    const row = await service.documentRecordGetById(PRODUCT_ID, result.document_id);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: result.document_id,
      r2_key: `${PRODUCT_ID}/documents/${result.document_id}/report.txt`,
      filename: 'report.txt',
      mime_type: 'text/plain',
      size_bytes: content.length,
      file_type: 'text',
      document_type: 'notes',
      description: 'integration fixture',
      user_id: 'user-doc',
      agent_id: null,
      session_id: null,
    });

    // Real R2 object: exact bytes + content type under the row's key.
    const blob = await env.DOCUMENTS_BUCKET.get(row!.r2_key);
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe(content);
    expect(blob!.httpMetadata?.contentType).toBe('text/plain');

    // Ingestion fan-out: internal auth + trace headers, document linkage.
    expect(ingestionRequests).toHaveLength(1);
    expect(ingestionRequests[0]!.headers['x-internal-key']).toBe('internal-test-key');
    expect(ingestionRequests[0]!.headers['x-trace-id']).toBe('trace-doc-int');
    expect(ingestionRequests[0]!.body).toMatchObject({
      product_id: PRODUCT_ID,
      content,
      scope: { user_id: 'user-doc' },
      source_channel: 'document',
      scene_type: 'document',
      document_id: result.document_id,
    });
  });

  it('chunks a long document and fans out one ingestion call per chunk', async () => {
    const { ctx, ingestionRequests } = makeHarness();
    // Three ~5.8k-char paragraphs: over MAX_CHUNK_CHARS (8000) total, so the
    // real chunker must split. Exact boundaries are pinned by chunking.test.ts.
    const paragraph = 'Quarterly revenue insight for the Lisbon office. '.repeat(115);
    const content = [paragraph, paragraph, paragraph].join('\n\n');

    const result = await uploadDocument(
      parsedUpload(content, 'big.txt', { idempotencyKey: 'big' }),
      ctx,
    );

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(ingestionRequests).toHaveLength(result.chunks);
    expect(result.instance_ids).toHaveLength(result.chunks);
    // Every chunk targets the same document and carries a per-chunk
    // idempotency key so a client retry cannot double-ingest any chunk.
    ingestionRequests.forEach((req, i) => {
      expect(req.body.document_id).toBe(result.document_id);
      expect(req.body.idempotency_key).toBe(`big:chunk-${i}`);
    });
  });
});

describe('document delete cascade over real D1 + R2', () => {
  it('removes exactly the linked memories, audits, FTS entries, vectors, blob, and row', async () => {
    const { service, ctx, deleteByIds, ingestionRequests } = makeHarness();

    // Target document with three extracted memories.
    const target = await uploadDocument(parsedUpload('target doc body', 'target.txt'), ctx);
    const m1 = await seedLinkedMemory(service, target.document_id, 'User rides a unicycle daily');
    const m2 = await seedLinkedMemory(service, target.document_id, 'User works from Porto');
    const m3 = await seedLinkedMemory(service, target.document_id, 'User prefers oat milk');

    // Survivor state: another document with its own memory, plus a plain
    // chat memory with no document at all.
    const other = await uploadDocument(parsedUpload('other doc body', 'other.txt'), ctx);
    const otherMemory = await seedLinkedMemory(
      service,
      other.document_id,
      'User collects vintage typewriters',
    );
    const chatMemory = await service.memoryCreate(
      PRODUCT_ID,
      makeMemoryInput({ content: 'User plays saxophone weekly', source_channel: 'chat' }),
    );
    const targetR2Key = `${PRODUCT_ID}/documents/${target.document_id}/target.txt`;
    const otherR2Key = `${PRODUCT_ID}/documents/${other.document_id}/other.txt`;
    deleteByIds.mockClear();
    ingestionRequests.length = 0;

    const result = await deleteDocument(target.document_id, ctx);

    // D1 meta.changes on the memories DELETE includes FTS trigger writes,
    // so the count is a lower bound; the survivor sets below are exact.
    expect(result.deleted).toBe(true);
    expect(result.document_id).toBe(target.document_id);
    expect(result.memories_deleted).toBeGreaterThanOrEqual(3);
    expect(result.vectors_deleted).toBe(3);
    expect(result.audits_deleted).toBe(3);

    // Vector cleanup hit the raw binding once, with exactly the linked ids.
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect([...deleteByIds.mock.calls[0]![0]].sort()).toEqual([m1.id, m2.id, m3.id].sort());

    // Linked memories and their audits are gone; survivors fully intact.
    expect(await service.memoryGetByIds(PRODUCT_ID, [m1.id, m2.id, m3.id])).toEqual([]);
    for (const id of [m1.id, m2.id, m3.id]) {
      expect(await service.auditGetByMemoryId(PRODUCT_ID, id)).toEqual([]);
    }
    const survivors = await service.memoryGetByIds(PRODUCT_ID, [otherMemory.id, chatMemory.id]);
    expect(survivors.map((m) => m.id).sort()).toEqual([otherMemory.id, chatMemory.id].sort());
    expect(await service.auditGetByMemoryId(PRODUCT_ID, otherMemory.id)).toHaveLength(1);

    // FTS: the AFTER DELETE trigger dropped the deleted content, while the
    // survivor's content is still searchable.
    const goneHits = await service.memorySearch(
      PRODUCT_ID,
      'unicycle',
      { user_id: 'user-doc' },
      10,
    );
    expect(goneHits).toEqual([]);
    const keptHits = await service.memorySearch(
      PRODUCT_ID,
      'typewriters',
      { user_id: 'user-doc' },
      10,
    );
    expect(keptHits.map((m) => m.id)).toContain(otherMemory.id);

    // R2: the target blob is gone, the other document's blob remains.
    expect(await env.DOCUMENTS_BUCKET.get(targetR2Key)).toBeNull();
    expect(await env.DOCUMENTS_BUCKET.get(otherR2Key)).not.toBeNull();

    // D1: the target row is gone, the other row remains. No ingestion calls
    // happen on delete.
    expect(await service.documentRecordGetById(PRODUCT_ID, target.document_id)).toBeNull();
    expect(await service.documentRecordGetById(PRODUCT_ID, other.document_id)).not.toBeNull();
    expect(ingestionRequests).toHaveLength(0);
  });

  it('a second delete of the same document 404s without touching other state', async () => {
    const { service, ctx } = makeHarness();
    const doc = await uploadDocument(parsedUpload('short-lived', 'gone.txt'), ctx);
    await deleteDocument(doc.document_id, ctx);

    await expect(deleteDocument(doc.document_id, ctx)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(await service.documentRecordGetById(PRODUCT_ID, doc.document_id)).toBeNull();
  });
});

describe('document replace over real D1 + R2', () => {
  it('swaps the blob, updates the row, and cascades only the old version', async () => {
    const { service, ctx, deleteByIds, ingestionRequests } = makeHarness();

    const uploaded = await uploadDocument(parsedUpload('version one body', 'v1.txt'), ctx);
    const oldRow = (await service.documentRecordGetById(PRODUCT_ID, uploaded.document_id))!;
    const oldM1 = await seedLinkedMemory(
      service,
      uploaded.document_id,
      'Old fact from version one',
    );
    const oldM2 = await seedLinkedMemory(service, uploaded.document_id, 'Another stale extraction');
    deleteByIds.mockClear();
    ingestionRequests.length = 0;

    const newContent = 'version two body with fresh knowledge';
    const result = await replaceDocument(
      oldRow,
      parsedUpload(newContent, 'v2.txt', { scope: { user_id: 'user-two' } }),
      ctx,
    );

    expect(result.document_id).toBe(uploaded.document_id);
    expect(result.old_memories_deleted).toBeGreaterThanOrEqual(2);
    expect(result.old_vectors_deleted).toBe(2);
    expect(result.old_audits_deleted).toBe(2);

    // Row now points at a revision-scoped key and carries the NEW scope
    // (replace legitimately reassigns the document).
    const newRow = (await service.documentRecordGetById(PRODUCT_ID, uploaded.document_id))!;
    expect(newRow.r2_key).toMatch(
      new RegExp(`^${PRODUCT_ID}/documents/${uploaded.document_id}/\\d+-v2\\.txt$`),
    );
    expect(newRow.filename).toBe('v2.txt');
    expect(newRow.size_bytes).toBe(newContent.length);
    expect(newRow.user_id).toBe('user-two');

    // R2: new blob live, old blob gone.
    const newBlob = await env.DOCUMENTS_BUCKET.get(newRow.r2_key);
    expect(await newBlob!.text()).toBe(newContent);
    expect(await env.DOCUMENTS_BUCKET.get(oldRow.r2_key)).toBeNull();

    // Old version's memories, audits, and vectors are gone.
    expect(await service.memoryGetByIds(PRODUCT_ID, [oldM1.id, oldM2.id])).toEqual([]);
    expect(await service.auditGetByMemoryId(PRODUCT_ID, oldM1.id)).toEqual([]);
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect([...deleteByIds.mock.calls[0]![0]].sort()).toEqual([oldM1.id, oldM2.id].sort());

    // The new content was re-ingested against the SAME document id.
    expect(ingestionRequests).toHaveLength(1);
    expect(ingestionRequests[0]!.body).toMatchObject({
      content: newContent,
      document_id: uploaded.document_id,
      scope: { user_id: 'user-two' },
    });
  });
});
