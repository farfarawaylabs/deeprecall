/**
 * A correction request failed in a way the caller can act on. Carries the
 * HTTP status + machine code so the route layer can shape the standard
 * error envelope without the business logic knowing about Hono. Mirrors
 * DocumentRequestError in src/documents/errors.ts.
 */
export class CorrectionRequestError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 500,
    readonly code: 'NOT_FOUND' | 'AUTHENTICATION_ERROR' | 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = 'CorrectionRequestError';
  }
}
