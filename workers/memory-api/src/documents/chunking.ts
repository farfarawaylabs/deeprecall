/** Approximate max characters per chunk (~2000 tokens at ~4 chars/token). */
export const MAX_CHUNK_CHARS = 8000;
/** Overlap between chunks to preserve context at boundaries. */
export const OVERLAP_CHARS = 500;

/**
 * Split text into chunks for processing by the ingestion pipeline.
 * Tries to split at paragraph boundaries, falls back to sentence boundaries,
 * then to fixed-size windows with overlap.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHUNK_CHARS) {
    return [trimmed];
  }

  const chunks: string[] = [];
  // Split by double newlines (paragraphs) first
  const paragraphs = trimmed.split(/\n\s*\n/);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const candidate = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;

    if (candidate.length <= MAX_CHUNK_CHARS) {
      currentChunk = candidate;
    } else if (currentChunk) {
      chunks.push(currentChunk);
      // Keep overlap from the end of the previous chunk
      currentChunk =
        currentChunk.length > OVERLAP_CHARS
          ? currentChunk.slice(-OVERLAP_CHARS) + '\n\n' + paragraph
          : paragraph;
      // If the new chunk is still too big, force-split the paragraph
      if (currentChunk.length > MAX_CHUNK_CHARS) {
        const subChunks = fixedSizeChunk(currentChunk);
        chunks.push(...subChunks.slice(0, -1));
        currentChunk = subChunks[subChunks.length - 1];
      }
    } else {
      // Single paragraph bigger than max — force split
      const subChunks = fixedSizeChunk(paragraph);
      chunks.push(...subChunks.slice(0, -1));
      currentChunk = subChunks[subChunks.length - 1];
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/** Fixed-size chunk split with overlap, splitting at sentence boundaries when possible. */
export function fixedSizeChunk(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, text.length);

    // Try to break at a sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('. ', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + MAX_CHUNK_CHARS / 2) {
        end = breakPoint + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    // The final window ends the walk — without this, the overlap step-back
    // re-enters the tail repeatedly and emits degenerate near-duplicate
    // chunks (one per character of overlap).
    if (end >= text.length) break;
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }

  return chunks;
}
