import type { Memory, RetrievalMode, Scope } from '@deeprecall/types';

export interface RetrievalRequest {
  query: string;
  scope: Scope;
  mode: RetrievalMode;
  top_k: number;
}

export interface ScoredMemoryResult {
  memory: Memory;
  score: number;
}

export interface RetrievalResponse {
  memories: ScoredMemoryResult[];
  total: number;
  mode: RetrievalMode;
}
