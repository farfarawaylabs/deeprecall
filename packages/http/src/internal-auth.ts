import { timingSafeEqual } from './crypto';
import { errorResponse } from './api-error';

// Internal service authentication for workers reachable only via service
// bindings (ingestion, retrieval).
//
// Defense in depth: the primary protection is network isolation
// (workers_dev/preview_urls disabled in wrangler.jsonc — these workers have
// no public URL). This shared-secret header check fails closed so that if a
// public route is ever re-enabled by a config mistake, the exposure stays
// shut.
//
// The caller (memory-api) attaches X-Internal-Key on every service-binding
// fetch; see internalFetch in this package.

/**
 * Verify the internal shared-secret header. Fails closed: if the worker has no
 * INTERNAL_SERVICE_KEY configured, every request is rejected (500) rather than
 * silently allowed. Returns a Response to short-circuit on denial, or null when
 * the request is authorized.
 */
export function verifyInternalKey(request: Request, expected: string | undefined): Response | null {
  // Tag denials so the caller (memory-api's internalFetch) can mask them behind
  // a generic 502 — an internal-auth failure must never surface to an external
  // client as a 401, which would look like *their* API key was rejected.
  if (!expected) {
    return errorResponse(
      500,
      'INTERNAL_MISCONFIGURED',
      'Internal service authentication is not configured',
      { headers: { 'X-Internal-Auth-Failure': '1' } },
    );
  }

  const provided = request.headers.get('x-internal-key');
  if (!provided || !timingSafeEqual(provided, expected)) {
    return errorResponse(401, 'UNAUTHORIZED', 'Invalid or missing internal service key', {
      headers: { 'X-Internal-Auth-Failure': '1' },
    });
  }

  return null;
}

/**
 * Wrap a service-binding fetch so every internal call to the ingestion and
 * retrieval workers carries the shared-secret header they verify. Using this
 * wrapper — rather than calling `binding.fetch` directly — keeps the header
 * injection in one place so a new call site can't silently omit it.
 *
 * If INTERNAL_SERVICE_KEY is unset, no header is attached and the receiver
 * fails closed (rejects the request), surfacing the misconfiguration.
 */
export async function internalFetch(
  binding: Fetcher,
  request: Request,
  key: string | undefined,
): Promise<Response> {
  const authed = new Request(request);
  if (key) authed.headers.set('X-Internal-Key', key);
  const response = await binding.fetch(authed);

  // A tagged internal-auth failure (missing/wrong/unset secret) is a
  // server-side misconfiguration, not a client error. Mask it behind a generic
  // 502 so an external caller with a valid API key never sees a bare 401/500
  // that leaks internal architecture or looks like their own key was rejected.
  if (response.headers.get('X-Internal-Auth-Failure')) {
    return errorResponse(502, 'UPSTREAM_ERROR', 'Internal service call failed');
  }

  return response;
}
