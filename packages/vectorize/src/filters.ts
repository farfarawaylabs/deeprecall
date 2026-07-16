import type { VectorSearchFilters } from './types';

/**
 * Scope passed by callers. At least one of user_id/agent_id must be set.
 */
export interface ScopeForFilters {
  user_id?: string;
  agent_id?: string;
}

/**
 * Build Vectorize filter objects for a scoped search.
 *
 * Because Vectorize does NOT support OR within a single filter, a scope
 * that carries both user_id and agent_id must be satisfied as a union of
 * two separate queries. The upstream caller fans out these queries in
 * parallel, unions the results by id, and rehydrates from D1.
 *
 * Cases:
 *   - user_id only:  one filter { user_id, ...extras }
 *   - agent_id only: one filter { agent_id, ...extras }
 *   - both set:      two filters [{ user_id, ...extras }, { agent_id, ...extras }]
 *     — memories with both fields appear in both result sets (dedupe by id).
 *     — memories with null on one dimension are covered by the filter on the other.
 *
 * @throws if neither user_id nor agent_id is provided.
 */
export function buildVectorizeFilters(
  scope: ScopeForFilters,
  extras: Omit<VectorSearchFilters, 'user_id' | 'agent_id'> = {},
): VectorSearchFilters[] {
  const filters: VectorSearchFilters[] = [];
  if (scope.user_id) {
    filters.push({ ...extras, user_id: scope.user_id });
  }
  if (scope.agent_id) {
    filters.push({ ...extras, agent_id: scope.agent_id });
  }
  if (filters.length === 0) {
    throw new Error(
      'buildVectorizeFilters: scope must include at least one of user_id or agent_id',
    );
  }
  return filters;
}
