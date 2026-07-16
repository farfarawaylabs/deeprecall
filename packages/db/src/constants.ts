/**
 * D1 hard limit: max bound parameters per query. Queries with `IN (...)`
 * placeholder lists must chunk their inputs to stay under it.
 */
export const D1_MAX_BOUND_PARAMS = 100;
