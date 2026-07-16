import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { DocumentListQuery } from '@deeprecall/types';
import type { AppBindings } from '../types';
import { DocumentRequestError } from '../documents/errors';
import { parseDocumentUpload } from '../documents/multipart';
import {
  assertDocumentIngestionEnabled,
  deleteDocument,
  getDocumentOrThrow,
  replaceDocument,
  uploadDocument,
  type DocumentsContext,
} from '../documents/documents-service';

export const documents = new Hono<AppBindings>();

/** Assemble the BL context from the request. */
function documentsContext(c: Context<AppBindings>): DocumentsContext {
  return {
    env: c.env,
    productId: c.get('product_id'),
    traceId: c.get('trace_id'),
  };
}

/**
 * POST /v1/documents
 * Upload a document for memory extraction.
 * Accepts multipart/form-data with file + metadata fields.
 */
documents.post('/', async (c) => {
  const ctx = documentsContext(c);

  try {
    await assertDocumentIngestionEnabled(ctx);
    const upload = await parseDocumentUpload(await c.req.parseBody(), {
      document_type: null,
      description: null,
    });
    const result = await uploadDocument(upload, ctx);
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DocumentRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * GET /v1/documents
 * List documents with cursor pagination. Scope filters are optional and
 * use relaxed matching (null on the row passes), mirroring memory list
 * semantics — an agent-only document with no user surfaces alongside a
 * user query. All filters can be omitted to list every document in the
 * product (admin-style inventory).
 */
documents.get('/', async (c) => {
  const productId = c.get('product_id');

  const parsed = DocumentListQuery.safeParse({
    user_id: c.req.query('user_id'),
    agent_id: c.req.query('agent_id'),
    session_id: c.req.query('session_id'),
    document_type: c.req.query('document_type'),
    file_type: c.req.query('file_type'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.flatten());
  }
  const { user_id, agent_id, session_id, document_type, file_type, limit, cursor } = parsed.data;

  const result = await c.env.DATA.documentRecordList(
    productId,
    { user_id, agent_id, session_id, document_type, file_type },
    { limit, cursor },
  );

  return c.json({
    documents: result.items,
    next_cursor: result.cursor,
  });
});

/**
 * GET /v1/documents/:document_id
 * Get document metadata.
 */
documents.get('/:document_id', async (c) => {
  try {
    const document = await getDocumentOrThrow(documentsContext(c), c.req.param('document_id'));
    return c.json({ document });
  } catch (err) {
    if (err instanceof DocumentRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * GET /v1/documents/:document_id/content
 * Stream the document content from R2.
 */
documents.get('/:document_id/content', async (c) => {
  const ctx = documentsContext(c);

  try {
    const document = await getDocumentOrThrow(ctx, c.req.param('document_id'));

    const r2Object = await ctx.env.DATA.documentDownload(document.r2_key);
    if (!r2Object) {
      return apiError(c, 404, 'NOT_FOUND', `Document content not found in storage`);
    }

    const safeFilename = (document.filename ?? 'download').replace(/[^\w.-]/g, '_');

    return new Response(r2Object.body, {
      status: 200,
      headers: {
        'Content-Type': r2Object.contentType,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        // Defense in depth — prevents MIME sniffing on uploaded HTML/SVG
        // that slipped past the text-extraction allowlist. Attachment
        // disposition already forces download; nosniff blocks the rare
        // browser that would run the script anyway.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof DocumentRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * PUT /v1/documents/:document_id
 * Replace a document's content with a new upload. Preserves the document_id
 * but otherwise behaves like a delete + upload in one call. The scope in
 * the new multipart body replaces the original uploaded_by — callers can
 * legitimately reassign a doc from one user/agent to another.
 */
documents.put('/:document_id', async (c) => {
  const ctx = documentsContext(c);

  try {
    await assertDocumentIngestionEnabled(ctx);
    const existing = await getDocumentOrThrow(ctx, c.req.param('document_id'));
    // Absent fields preserve the existing document's values; explicitly
    // empty fields clear them.
    const upload = await parseDocumentUpload(await c.req.parseBody(), {
      document_type: existing.document_type,
      description: existing.description,
    });
    const result = await replaceDocument(existing, upload, ctx);
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DocumentRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});

/**
 * DELETE /v1/documents/:document_id
 * Sync cascade delete for a single document: memories extracted from it
 * (with vectors and audits), the R2 blob, and the document row. Runs sync
 * because per-doc memory counts are small; oversize cascades are rejected
 * with CASCADE_TOO_LARGE and routed to the async purge path.
 */
documents.delete('/:document_id', async (c) => {
  try {
    const result = await deleteDocument(c.req.param('document_id'), documentsContext(c));
    return c.json(result);
  } catch (err) {
    if (err instanceof DocumentRequestError) {
      return apiError(c, err.status, err.code, err.message, err.details);
    }
    throw err;
  }
});
