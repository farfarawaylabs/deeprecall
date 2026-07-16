import { Scope } from '@deeprecall/types';
import type { FileType } from '@deeprecall/types';
import { DocumentRequestError } from './errors';
import { extractFileText, resolveFileType, SUPPORTED_FILE_TYPES_MESSAGE } from './file-type';

/** Maximum accepted upload size. */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** The body shape Hono's parseBody() produces for multipart/form-data. */
export type MultipartBody = Record<string, string | File | (string | File)[]>;

/**
 * Field defaults applied when a multipart field is absent. POST passes nulls
 * (fresh upload); PUT passes the existing document's values so an omitted
 * field preserves them while an explicitly-empty field clears to NULL.
 */
export interface DocumentFieldDefaults {
  document_type: string | null;
  description: string | null;
}

/** A fully validated document upload, ready for the upload/replace flows. */
export interface ParsedDocumentUpload {
  file: File;
  scope: Scope;
  documentType: string | null;
  description: string | null;
  sceneType: string;
  idempotencyKey: string | undefined;
  fileType: FileType;
  /** Clone for R2 — PDF extraction and RPC both transfer/detach ArrayBuffers. */
  r2Buffer: ArrayBuffer;
  textContent: string;
}

/**
 * Validate and extract a document upload from a parsed multipart body.
 * Shared by POST (create) and PUT (replace) — the checks run in the same
 * order the original handlers used, so first-error-wins behavior is
 * preserved: file presence → size → scope → fields → file type → content.
 * Throws DocumentRequestError for every caller-visible failure.
 */
export async function parseDocumentUpload(
  body: MultipartBody,
  defaults: DocumentFieldDefaults,
): Promise<ParsedDocumentUpload> {
  const file = body['file'];
  if (!file || !(file instanceof File)) {
    throw new DocumentRequestError(
      "Missing or invalid 'file' field. Must be a file upload.",
      400,
      'VALIDATION_ERROR',
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new DocumentRequestError(
      `File size ${file.size} exceeds maximum of 25 MB`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  const scopeRaw = body['scope'];
  if (!scopeRaw || typeof scopeRaw !== 'string') {
    throw new DocumentRequestError(
      "Missing or invalid 'scope' field. Must be a JSON string.",
      400,
      'VALIDATION_ERROR',
    );
  }

  let scopeParsed: unknown;
  try {
    scopeParsed = JSON.parse(scopeRaw);
  } catch {
    throw new DocumentRequestError("Invalid JSON in 'scope' field.", 400, 'VALIDATION_ERROR');
  }

  const scopeResult = Scope.safeParse(scopeParsed);
  if (!scopeResult.success) {
    throw new DocumentRequestError(
      'Invalid scope',
      400,
      'VALIDATION_ERROR',
      scopeResult.error.flatten(),
    );
  }
  const scope = scopeResult.data;

  // document_type is a free-form classification tag supplied by the product
  // (e.g., "knowledge_file", "transcript", "meeting_notes"). Present-but-empty
  // stores NULL (caller explicitly cleared the tag); absent falls back to the
  // caller-supplied default. No enum, no server-side meaning — just a tag
  // that drives the list filter.
  let documentType: string | null;
  if (body['document_type'] !== undefined) {
    const raw = body['document_type'];
    documentType = typeof raw === 'string' && raw.length > 0 ? raw : null;
  } else {
    documentType = defaults.document_type;
  }

  const description =
    body['description'] !== undefined
      ? (body['description'] as string) || null
      : defaults.description;
  const sceneType = (body['scene_type'] as string) || 'document';
  const idempotencyKey = (body['idempotency_key'] as string) || undefined;

  // Decide whether we can ingest this file BEFORE any destructive or
  // stateful step — if the MIME/filename combo isn't a format we know how
  // to extract, reject early with the closed set of formats we support.
  const fileType = resolveFileType(file.type || null, file.name || null);
  if (!fileType) {
    throw new DocumentRequestError(
      `Unsupported file. MIME '${file.type || 'unknown'}' (filename '${file.name || 'unnamed'}') does not match any supported file type. Supported: ${SUPPORTED_FILE_TYPES_MESSAGE}.`,
      422,
      'UNSUPPORTED_CONTENT',
    );
  }

  // Clone the buffer — PDF extraction and RPC both transfer/detach ArrayBuffers
  const fileBuffer = await file.arrayBuffer();
  const r2Buffer = fileBuffer.slice(0);
  const textContent = await extractFileText(fileType, fileBuffer);

  if (!textContent || textContent.trim().length === 0) {
    throw new DocumentRequestError(
      `File was '${fileType}' but had no extractable text.`,
      422,
      'UNSUPPORTED_CONTENT',
    );
  }

  return {
    file,
    scope,
    documentType,
    description,
    sceneType,
    idempotencyKey,
    fileType,
    r2Buffer,
    textContent,
  };
}
