import type { Context } from 'hono';
import type { LogContext } from '@deeprecall/logger';
import { CloudflareApiClient } from './cloudflare-api';
import { ManagementRequestError } from './errors';
import type { AppBindings } from './types';

/** Request-scoped context handed to every management BL function. */
export interface ManagementContext {
  env: Env;
  logCtx: LogContext | undefined;
}

/** Assemble the BL context from a Hono request context. */
export function managementContext(c: Context<AppBindings>): ManagementContext {
  return { env: c.env, logCtx: c.get('log_ctx') };
}

/**
 * The subset of CloudflareApiClient the management flows use — injectable
 * so unit tests can exercise provisioning/migration branches without real
 * API calls.
 */
export type CloudflareApi = Pick<
  CloudflareApiClient,
  | 'createD1Database'
  | 'createVectorizeIndex'
  | 'createVectorizeMetadataIndex'
  | 'deleteD1Database'
  | 'deleteVectorizeIndex'
  | 'executeD1Sql'
>;
export type CloudflareApiFactory = (apiToken: string, accountId: string) => CloudflareApi;

export const defaultCfApiFactory: CloudflareApiFactory = (apiToken, accountId) =>
  new CloudflareApiClient(apiToken, accountId);

/**
 * Validate the Cloudflare API secrets and return a ready client. Throws
 * CONFIGURATION_ERROR when either is missing — checked before any
 * provisioning/migration work so misconfiguration never half-executes.
 */
export function requireCfApi(
  ctx: ManagementContext,
  cfApiFactory: CloudflareApiFactory,
): CloudflareApi {
  const apiToken = ctx.env.CLOUDFLARE_API_TOKEN;
  const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    throw new ManagementRequestError(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets must be configured',
      500,
      'CONFIGURATION_ERROR',
    );
  }
  return cfApiFactory(apiToken, accountId);
}
