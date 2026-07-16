import type { IVectorSearchService, VectorUpsertItem } from './interfaces';
import type { VectorMetadata, VectorSearchResult, VectorSearchFilters } from './types';

/** Vectorize deleteByIds hard limit: max 100 ids per call (API error 40007). */
const DELETE_BY_IDS_LIMIT = 100;

/** Conservative batch size for upserts — well under Vectorize's per-call cap. */
const UPSERT_BATCH_LIMIT = 100;

/**
 * Build metadata conditionally — never write null for user_id/agent_id.
 * Null values would poison filter queries that expect either the value
 * or "field absent". Vectorize filters cannot match null.
 */
function cleanVectorMetadata(metadata: VectorMetadata): Record<string, unknown> {
  const cleanMetadata: Record<string, unknown> = {
    type: metadata.type,
    status: metadata.status,
    source_type: metadata.source_type,
    confidence: metadata.confidence,
  };
  if (metadata.user_id) cleanMetadata.user_id = metadata.user_id;
  if (metadata.agent_id) cleanMetadata.agent_id = metadata.agent_id;
  return cleanMetadata;
}

export class CloudflareVectorizeService implements IVectorSearchService {
  constructor(private index: VectorizeIndex) {}

  async upsert(memoryId: string, embedding: number[], metadata: VectorMetadata): Promise<void> {
    await this.upsertMany([{ memoryId, embedding, metadata }]);
  }

  async upsertMany(items: VectorUpsertItem[]): Promise<void> {
    // One Vectorize call per chunk instead of one per vector — bulk import
    // rate-limits (429, error 40041) are driven by request count.
    for (let i = 0; i < items.length; i += UPSERT_BATCH_LIMIT) {
      await this.index.upsert(
        items.slice(i, i + UPSERT_BATCH_LIMIT).map((item) => ({
          id: item.memoryId,
          values: item.embedding,
          metadata: cleanVectorMetadata(item.metadata) as Record<string, VectorizeVectorMetadata>,
        })),
      );
    }
  }

  async search(
    embedding: number[],
    filters: VectorSearchFilters,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    const metadataFilter: VectorizeVectorMetadataFilter = {};

    if (filters.user_id) {
      metadataFilter.user_id = filters.user_id;
    }
    if (filters.agent_id) {
      metadataFilter.agent_id = filters.agent_id;
    }
    if (filters.status) {
      metadataFilter.status = filters.status;
    }
    if (filters.type) {
      metadataFilter.type = filters.type;
    }

    const results = await this.index.query(embedding, {
      topK,
      filter: metadataFilter,
    });

    return results.matches.map((match) => ({
      memory_id: match.id,
      score: match.score,
    }));
  }

  async delete(memoryId: string): Promise<void> {
    await this.index.deleteByIds([memoryId]);
  }

  async deleteMany(memoryIds: string[]): Promise<void> {
    // Vectorize deleteByIds rejects payloads over 100 ids (error 40007).
    for (let i = 0; i < memoryIds.length; i += DELETE_BY_IDS_LIMIT) {
      await this.index.deleteByIds(memoryIds.slice(i, i + DELETE_BY_IDS_LIMIT));
    }
  }
}
