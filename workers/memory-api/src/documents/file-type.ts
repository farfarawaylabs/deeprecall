import type { FileType } from '@deeprecall/types';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Closed set of file formats the pipeline can extract text from. The
 * `FileType` enum is the source of truth; this map and `resolveFileType`
 * together express what MIME types (and filename fallbacks) resolve to
 * each format. When adding a new format: extend `FileType`, add a branch
 * below, and add the corresponding text-extraction path.
 */
export const SUPPORTED_FILE_TYPES_MESSAGE = 'pdf, markdown, text, json';

/**
 * Derive a `FileType` from the uploaded file's MIME + filename. Returns
 * null when the file isn't something the pipeline can ingest — callers
 * must reject such uploads with UNSUPPORTED_CONTENT. Markdown is detected
 * either by MIME (`text/markdown`, `text/x-markdown`) or by filename
 * extension (`.md`, `.markdown`), since many clients upload markdown as
 * `text/plain` or `application/octet-stream`.
 */
export function resolveFileType(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): FileType | null {
  const mime = (mimeType ?? '').toLowerCase();
  const name = (filename ?? '').toLowerCase();
  const isMarkdownExt = name.endsWith('.md') || name.endsWith('.markdown');

  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (isMarkdownExt) return 'markdown';
  if (mime === 'application/json') return 'json';
  if (mime.startsWith('text/')) return 'text';
  // Common fallback for drag-and-drop uploads of plain .txt/.md where the
  // browser didn't set a MIME. Only accept if the filename has a known
  // text-ish extension — otherwise reject as unsupported.
  if (!mime || mime === 'application/octet-stream') {
    if (isMarkdownExt) return 'markdown';
    if (name.endsWith('.txt')) return 'text';
    if (name.endsWith('.json')) return 'json';
  }
  return null;
}

/**
 * Extract plain text from an uploaded file given its resolved `FileType`.
 * Returns null when the file was technically a supported type but had no
 * extractable content (empty PDF, empty text, etc.) — callers surface this
 * as UNSUPPORTED_CONTENT as well.
 */
export async function extractFileText(
  fileType: FileType,
  buffer: ArrayBuffer,
): Promise<string | null> {
  if (fileType === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === 'string' ? text : null;
  }
  // markdown, text, json all decode as UTF-8. We hand the raw text to the
  // ingestion pipeline — it doesn't need structural awareness of markdown
  // or JSON at the extraction step.
  return new TextDecoder().decode(buffer);
}
