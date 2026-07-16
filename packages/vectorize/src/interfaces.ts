import type { VectorMetadata, VectorSearchResult, VectorSearchFilters } from './types';

/** One vector to upsert: the memory it belongs to, its embedding, and filterable metadata. */
export interface VectorUpsertItem {
  /** Memory id — used as the vector id, and the join key back to the D1 row. */
  memoryId: string;
  /** Embedding vector; length must match the index dimensions (1024 for bge-m3). */
  embedding: number[];
  /**
   * Scope + lifecycle metadata for filtered search. Absent scope keys are
   * OMITTED from the stored metadata, never written as null — Vectorize
   * filters cannot match null, and key absence is what makes relaxed-scope
   * matching work.
   */
  metadata: VectorMetadata;
}

/**
 * Vector index abstraction — the vector-side twin of the repository
 * interfaces in `@deeprecall/db`. Business logic imports this interface,
 * never Vectorize types directly; `CloudflareVectorizeService` is the only
 * implementation. Swapping Vectorize for another vector store (e.g.
 * pgvector) means reimplementing this interface and nothing above it.
 */
export interface IVectorSearchService {
  /** Upsert a single vector (convenience wrapper over {@link upsertMany}). */
  upsert(memoryId: string, embedding: number[], metadata: VectorMetadata): Promise<void>;

  /**
   * Upsert vectors in bulk, internally batched to stay under the per-call
   * Vectorize cap (one API call per 100 vectors). Existing ids are
   * overwritten — upserting after a metadata change (e.g. status flip) is
   * the way to update a vector's filterable state.
   */
  upsertMany(items: VectorUpsertItem[]): Promise<void>;

  /**
   * Similarity search returning `memory_id` + score pairs, best first.
   * Set filter keys are ANDed; Vectorize has no OR within one filter, so a
   * scope needing a user/agent union must fan out one search per filter
   * variant (see `buildVectorizeFilters`) and union results by id. Filters
   * only apply to properties with a metadata index — a missing index means
   * the filter is silently ignored, not an error. Callers must verify the
   * returned ids still exist in D1 (ghost-vector defense) before use.
   */
  search(
    embedding: number[],
    filters: VectorSearchFilters,
    topK: number,
  ): Promise<VectorSearchResult[]>;

  /** Delete a single vector by memory id. Deleting a nonexistent id is a no-op. */
  delete(memoryId: string): Promise<void>;

  /**
   * Delete vectors in bulk, internally chunked to Vectorize's hard limit of
   * 100 ids per call. Used by purge/cascade flows, which batch well above
   * that limit.
   */
  deleteMany(memoryIds: string[]): Promise<void>;
}
