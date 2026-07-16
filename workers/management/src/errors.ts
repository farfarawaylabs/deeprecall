/**
 * A management request failed in a way the caller can act on. Carries the
 * HTTP status + machine code so the route layer can shape the standard
 * error envelope without the business logic knowing about Hono. Mirrors
 * the memory-api pattern (DocumentRequestError / CorrectionRequestError).
 */
export class ManagementRequestError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 500,
    readonly code:
      | 'CONFLICT'
      | 'CONFIGURATION_ERROR'
      | 'PROVISIONING_ERROR'
      | 'PROVISIONING_METADATA_INDEX_ERROR'
      | 'NOT_FOUND'
      | 'INTERNAL_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ManagementRequestError';
  }
}
