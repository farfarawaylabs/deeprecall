import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Standard API error response: { error: { code, message, details? } }.
 * Every user-facing error in every worker goes through this helper so the
 * envelope shape cannot drift between routes (audit finding C8: 101
 * hand-rolled literals across four workers).
 */
export function apiError<E extends Env>(
  c: Context<E>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
    status,
  );
}

/**
 * Same envelope for non-Hono contexts (raw fetch handlers, e.g. the internal
 * workers' service-binding endpoints). Status is constrained to codes that
 * may carry a body — a bodiless status (204, 304) would throw at runtime.
 */
export function errorResponse(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  init?: { headers?: Record<string, string>; details?: unknown },
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(init?.details !== undefined ? { details: init.details } : {}),
      },
    },
    { status, headers: init?.headers },
  );
}
