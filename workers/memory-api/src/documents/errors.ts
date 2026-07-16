/**
 * A document request failed in a way the caller can act on. Carries the HTTP
 * status + machine code so the route layer can shape the standard error
 * envelope without the business logic knowing about Hono. Mirrors
 * AnswerUpstreamError in src/answer/answer-service.ts.
 */
export class DocumentRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 502,
    readonly code:
      | 'VALIDATION_ERROR'
      | 'FEATURE_DISABLED'
      | 'NOT_FOUND'
      | 'CASCADE_TOO_LARGE'
      | 'FILE_TOO_LARGE'
      | 'UNSUPPORTED_CONTENT'
      | 'INGESTION_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DocumentRequestError';
  }
}
