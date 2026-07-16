/**
 * Metadata stored alongside a vector in Vectorize.
 * user_id and agent_id are optional — at least one should be set.
 * CRITICAL: Never write `null` — omit the key when absent.
 */
export interface VectorMetadata {
  user_id?: string;
  agent_id?: string;
  type: string;
  status: string;
  source_type: string;
  confidence: number;
}

export interface VectorSearchResult {
  memory_id: string;
  score: number;
}

export interface VectorSearchFilters {
  user_id?: string;
  agent_id?: string;
  status?: string;
  type?: string;
}
