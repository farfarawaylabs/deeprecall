import type { Document, Scope } from '@deeprecall/types';
import { internalFetch } from '@deeprecall/http';
import { chunkText } from './chunking';
import {
  cascadeDeleteDocumentMemories,
  listCascadeMemoryIds,
  MAX_CASCADE_MEMORIES,
} from './cascade';
import { DocumentRequestError } from './errors';
import type { ParsedDocumentUpload } from './multipart';

export interface DocumentsContext {
  env: Env;
  productId: string;
  traceId: string;
}

/** Response body for POST /v1/documents (202). */
export interface UploadDocumentResult {
  document_id: string;
  instance_id: string;
  instance_ids: string[];
  chunks: number;
  filename: string;
  size_bytes: number;
  message: string;
}

/** Response body for PUT /v1/documents/:id (202). */
export interface ReplaceDocumentResult extends UploadDocumentResult {
  old_memories_deleted: number;
  old_vectors_deleted: number;
  old_audits_deleted: number;
}

/** Response body for DELETE /v1/documents/:id (200). */
export interface DeleteDocumentResult {
  deleted: true;
  document_id: string;
  memories_deleted: number;
  vectors_deleted: number;
  audits_deleted: number;
}

/**
 * Reject when the product's config disables document ingestion. Products
 * without a stored config default to enabled.
 */
export async function assertDocumentIngestionEnabled(ctx: DocumentsContext): Promise<void> {
  const configStr = await ctx.env.CONFIG.get(`product:${ctx.productId}:config`);
  if (configStr) {
    const config = JSON.parse(configStr) as { features?: { document_ingestion?: boolean } };
    if (config.features?.document_ingestion === false) {
      throw new DocumentRequestError(
        'Document ingestion is not enabled for this product',
        403,
        'FEATURE_DISABLED',
      );
    }
  }
}

/** Fetch a document record, throwing NOT_FOUND when it doesn't exist. */
export async function getDocumentOrThrow(
  ctx: DocumentsContext,
  documentId: string,
): Promise<Document> {
  const document = await ctx.env.DATA.documentRecordGetById(ctx.productId, documentId);
  if (!document) {
    throw new DocumentRequestError(`Document ${documentId} not found`, 404, 'NOT_FOUND');
  }
  return document;
}

/**
 * Chunk extracted text and fan each chunk out to the ingestion pipeline via
 * the INGESTION service binding. Returns the workflow instance IDs that
 * started successfully; chunks whose ingestion call failed are skipped (the
 * caller decides whether zero successes is an error).
 */
async function ingestChunks(
  ctx: DocumentsContext,
  args: {
    chunks: string[];
    scope: Scope;
    sceneType: string;
    documentId: string;
    idempotencyKey: string | undefined;
  },
): Promise<string[]> {
  const instanceIds: string[] = [];

  for (let i = 0; i < args.chunks.length; i++) {
    const ingestionPayload = {
      product_id: ctx.productId,
      content: args.chunks[i],
      scope: args.scope,
      source_channel: 'document' as const,
      scene_type: args.sceneType,
      document_id: args.documentId,
      ...(args.idempotencyKey ? { idempotency_key: `${args.idempotencyKey}:chunk-${i}` } : {}),
    };

    const ingestionResponse = await internalFetch(
      ctx.env.INGESTION,
      new Request('https://internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-trace-id': ctx.traceId,
        },
        body: JSON.stringify(ingestionPayload),
      }),
      ctx.env.INTERNAL_SERVICE_KEY,
    );

    const ingestionResult = (await ingestionResponse.json()) as {
      instance_id?: string;
    };

    if (ingestionResponse.ok && ingestionResult.instance_id) {
      instanceIds.push(ingestionResult.instance_id);
    }
  }

  return instanceIds;
}

/**
 * Upload a new document: store the blob in R2, create the D1 record stamped
 * with the full upload scope (so later filtering and purging line up with
 * the memories extracted from it), then chunk and fan out ingestion.
 */
export async function uploadDocument(
  upload: ParsedDocumentUpload,
  ctx: DocumentsContext,
): Promise<UploadDocumentResult> {
  const documentId = crypto.randomUUID();
  const filename = upload.file.name || 'unnamed';
  const r2Key = `${ctx.productId}/documents/${documentId}/${filename}`;

  // Upload file to R2 (use cloned buffer — original may be detached by PDF extraction)
  await ctx.env.DATA.documentUpload(r2Key, upload.r2Buffer, upload.file.type);

  await ctx.env.DATA.documentRecordCreate(ctx.productId, {
    id: documentId,
    r2_key: r2Key,
    filename,
    mime_type: upload.file.type || null,
    size_bytes: upload.file.size,
    file_type: upload.fileType,
    document_type: upload.documentType,
    description: upload.description,
    user_id: upload.scope.user_id ?? null,
    agent_id: upload.scope.agent_id ?? null,
    session_id: upload.scope.session_id ?? null,
    metadata: upload.idempotencyKey ? { idempotency_key: upload.idempotencyKey } : null,
  });

  const chunks = chunkText(upload.textContent);
  const instanceIds = await ingestChunks(ctx, {
    chunks,
    scope: upload.scope,
    sceneType: upload.sceneType,
    documentId,
    idempotencyKey: upload.idempotencyKey,
  });

  if (instanceIds.length === 0) {
    throw new DocumentRequestError(
      'Document uploaded but ingestion failed to start',
      502,
      'INGESTION_ERROR',
    );
  }

  return {
    document_id: documentId,
    instance_id: instanceIds[0]!,
    instance_ids: instanceIds,
    chunks: chunks.length,
    filename,
    size_bytes: upload.file.size,
    message: `Document uploaded and ${chunks.length} chunk(s) sent for ingestion`,
  };
}

/**
 * Replace a document's content with a new upload. Preserves the document_id
 * but otherwise behaves like a delete + upload in one call:
 *   1. Upload the new R2 blob under a revision-scoped key
 *   2. Update the document row (filename, mime, size, r2_key, scope, ...)
 *   3. Cascade-delete memories extracted from the old version
 *   4. Delete the old R2 blob
 *   5. Chunk the new content and re-run the ingestion pipeline
 *
 * Ordered so the document row points at a valid R2 blob at every step: if
 * anything after step 1 fails, a retry converges (cascade and R2 deletes
 * are idempotent); if step 1 fails the old doc is untouched.
 *
 * The scope in the new multipart body replaces the original — callers can
 * legitimately reassign a doc from one user/agent to another.
 */
export async function replaceDocument(
  existing: Document,
  upload: ParsedDocumentUpload,
  ctx: DocumentsContext,
): Promise<ReplaceDocumentResult> {
  const documentId = existing.id;

  // Reject oversize cascades synchronously BEFORE any destructive step —
  // same threshold as DELETE by id.
  const oldMemoryIds = await listCascadeMemoryIds(
    ctx.env.DATA,
    ctx.productId,
    documentId,
    `Document has more than ${MAX_CASCADE_MEMORIES} linked memories; delete + re-upload explicitly via the async purge endpoint`,
  );

  // 1. Upload the new blob under a revision-scoped key so it can never
  //    collide with the existing.r2_key even if the filename is unchanged.
  const filename = upload.file.name || existing.filename || 'unnamed';
  const newR2Key = `${ctx.productId}/documents/${documentId}/${Date.now()}-${filename}`;
  await ctx.env.DATA.documentUpload(newR2Key, upload.r2Buffer, upload.file.type);

  // 2. Update the document row to point at the new blob. From this point
  //    on, GET /content returns the new content.
  await ctx.env.DATA.documentRecordUpdate(ctx.productId, documentId, {
    r2_key: newR2Key,
    filename,
    mime_type: upload.file.type || null,
    size_bytes: upload.file.size,
    file_type: upload.fileType,
    document_type: upload.documentType,
    description: upload.description,
    user_id: upload.scope.user_id ?? null,
    agent_id: upload.scope.agent_id ?? null,
    session_id: upload.scope.session_id ?? null,
    metadata: upload.idempotencyKey ? { idempotency_key: upload.idempotencyKey } : null,
  });

  // 3. Cascade old memories (vectors → audits → memories, with the
  //    concurrent-ingestion safety net).
  const counts = await cascadeDeleteDocumentMemories(
    ctx.env.DATA,
    ctx.productId,
    documentId,
    oldMemoryIds,
  );

  // 4. Delete the old R2 blob now that nothing references it. Idempotent
  //    under retry — R2 delete is a no-op on missing keys.
  if (existing.r2_key !== newR2Key) {
    await ctx.env.DATA.documentDelete(existing.r2_key);
  }

  // 5. Chunk + fan out ingestion for the new content.
  const chunks = chunkText(upload.textContent);
  const instanceIds = await ingestChunks(ctx, {
    chunks,
    scope: upload.scope,
    sceneType: upload.sceneType,
    documentId,
    idempotencyKey: upload.idempotencyKey,
  });

  if (instanceIds.length === 0) {
    throw new DocumentRequestError(
      'Document replaced but ingestion failed to start',
      502,
      'INGESTION_ERROR',
    );
  }

  return {
    document_id: documentId,
    instance_id: instanceIds[0]!,
    instance_ids: instanceIds,
    chunks: chunks.length,
    filename,
    size_bytes: upload.file.size,
    old_memories_deleted: counts.memoriesDeleted,
    old_vectors_deleted: counts.vectorsDeleted,
    old_audits_deleted: counts.auditsDeleted,
    message: `Document replaced and ${chunks.length} chunk(s) sent for ingestion`,
  };
}

/**
 * Sync cascade delete for a single document: every memory extracted from it
 * (with its Vectorize entry and audit rows), the R2 blob, and the document
 * row itself. Returns counts so callers can verify the cascade.
 */
export async function deleteDocument(
  documentId: string,
  ctx: DocumentsContext,
): Promise<DeleteDocumentResult> {
  const document = await getDocumentOrThrow(ctx, documentId);

  const memoryIds = await listCascadeMemoryIds(
    ctx.env.DATA,
    ctx.productId,
    documentId,
    `Document has more than ${MAX_CASCADE_MEMORIES} linked memories; use POST /v1/memories/purge or DELETE /v1/documents with scope for async processing`,
  );

  const counts = await cascadeDeleteDocumentMemories(
    ctx.env.DATA,
    ctx.productId,
    documentId,
    memoryIds,
  );

  await ctx.env.DATA.documentDelete(document.r2_key);
  await ctx.env.DATA.documentRecordDeleteById(ctx.productId, documentId);

  return {
    deleted: true,
    document_id: documentId,
    memories_deleted: counts.memoriesDeleted,
    vectors_deleted: counts.vectorsDeleted,
    audits_deleted: counts.auditsDeleted,
  };
}
