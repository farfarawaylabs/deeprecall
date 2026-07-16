import type { MemoryCandidate } from '@deeprecall/types';
import type { EmbeddedCandidate } from '../types';

/** Step 3: Generate embeddings for each candidate via the DATA service binding. */
export async function embed(
  candidates: MemoryCandidate[],
  data: { generateEmbeddings: (texts: string[]) => Promise<number[][]> },
): Promise<EmbeddedCandidate[]> {
  if (candidates.length === 0) return [];

  const texts = candidates.map((c) => c.content);
  const embeddings = await data.generateEmbeddings(texts);

  if (embeddings.length !== candidates.length) {
    throw new Error(
      `Embedding count mismatch: got ${embeddings.length}, expected ${candidates.length}`,
    );
  }

  return candidates.map((candidate, i) => ({
    candidate,
    embedding: embeddings[i],
  }));
}
