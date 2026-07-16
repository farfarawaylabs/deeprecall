import { errorResponse } from '@deeprecall/http';
import { claudeConfigFromEnv } from '@deeprecall/ai';
import { ConsolidationMessage, PurgeMessage } from '@deeprecall/types';
import { Logger } from '@deeprecall/logger';
import type { AxiomConfig, LogContext } from '@deeprecall/logger';
import { runExpirySweep } from './jobs/expiry-sweep';
import { runConfidenceDecay } from './jobs/confidence-decay';
import { runProfileConsolidation } from './jobs/profile-consolidation';
import { runConflictResolution } from './jobs/conflict-resolution';
import { runPurge, markPurgeFailed } from './jobs/purge';

function getAxiomConfig(env: Env): AxiomConfig | undefined {
  return env.AXIOM_API_TOKEN && env.AXIOM_DATASET
    ? { apiToken: env.AXIOM_API_TOKEN, dataset: env.AXIOM_DATASET }
    : undefined;
}

export default {
  /**
   * HTTP handler — health check only.
   */
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'consolidation' });
    }

    return errorResponse(404, 'NOT_FOUND', 'Not found');
  },

  /**
   * Queue consumer — processes consolidation messages from the ingestion pipeline.
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const logCtx = Logger.createContext('consolidation', { step: 'queue' });
    const axiomConfig = getAxiomConfig(env);

    for (const message of batch.messages) {
      const msgCtx = Logger.childContext(logCtx, `msg:${message.id}`);

      // Purge messages carry a `kind: "purge"` discriminator to distinguish
      // them from ConsolidationMessage payloads on the shared queue.
      const body = message.body as { kind?: unknown };
      const isPurge = body && typeof body === 'object' && body.kind === 'purge';

      if (isPurge) {
        await handlePurgeMessage(message, env, msgCtx);
        continue;
      }

      try {
        const parsed = ConsolidationMessage.safeParse(message.body);
        if (!parsed.success) {
          Logger.error(msgCtx, 'Invalid message payload', {
            error: parsed.error.message,
          });
          await writeDeadLetter(env.DATA, 'default', message, 'Invalid message payload');
          message.ack();
          continue;
        }

        msgCtx.product_id = parsed.data.product_id;
        msgCtx.user_id = parsed.data.scope.user_id;
        if (parsed.data.scope.agent_id) {
          (msgCtx as Record<string, unknown>).agent_id = parsed.data.scope.agent_id;
        }

        await processMessage(parsed.data, env, msgCtx);
        message.ack();
      } catch (error) {
        Logger.error(msgCtx, 'Failed to process message', {
          error: error instanceof Error ? error.message : String(error),
          attempts: message.attempts,
        });

        if (message.attempts >= 3) {
          await writeDeadLetter(env.DATA, 'default', message);
          message.ack();
        } else {
          message.retry();
        }
      }
    }

    if (axiomConfig) {
      await Logger.flush(logCtx, axiomConfig);
    }
  },

  /**
   * Cron handler — runs scheduled maintenance jobs.
   * Cron schedule (from wrangler.jsonc):
   *   "0 3 * * *"   — daily at 3 AM: expiry sweep + confidence decay
   *   "0 4 * * SUN"   — weekly on Sunday at 4 AM: profile rebuild for all users
   *
   * All cron jobs iterate over every registered product in KV.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronPattern = controller.cron;
    const logCtx = Logger.createContext('consolidation', { step: `cron:${cronPattern}` });
    const axiomConfig = getAxiomConfig(env);

    try {
      const productIds = await getAllProductIds(env);

      if (cronPattern === '0 3 * * *') {
        for (const productId of productIds) {
          const prodCtx = Logger.childContext(logCtx, `daily:${productId}`);
          prodCtx.product_id = productId;
          try {
            Logger.info(prodCtx, 'Running daily expiry sweep');
            const expiryResult = await runExpirySweep(env.DATA, productId);
            Logger.info(prodCtx, 'Expiry sweep complete', {
              expired_count: expiryResult.expired_count,
              idempotency_cleaned: expiryResult.idempotency_cleaned,
            });

            const decayConfigJson = await env.CONFIG.get('consolidation:confidence_decay');
            const decayConfig = decayConfigJson ? JSON.parse(decayConfigJson) : undefined;

            Logger.info(prodCtx, 'Running daily confidence decay');
            const decayResult = await runConfidenceDecay(env.DATA, productId, decayConfig);
            Logger.info(prodCtx, 'Confidence decay complete', {
              decayed_count: decayResult.decayed_count,
              archived_count: decayResult.archived_count,
            });
          } catch (error) {
            Logger.error(prodCtx, 'Daily job failed for product', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else if (cronPattern === '0 4 * * SUN') {
        ctx.waitUntil(runWeeklyProfileRebuild(env, productIds, axiomConfig));
      }
    } catch (error) {
      Logger.error(logCtx, 'Scheduled job failed', {
        cron: cronPattern,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (axiomConfig) {
      ctx.waitUntil(Logger.flush(logCtx, axiomConfig));
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Enumerate all registered product IDs from KV.
 * Lists keys with prefix "product:" and filters for ":config" suffix
 * to extract unique product IDs.
 */
async function getAllProductIds(env: Env): Promise<string[]> {
  const productIds: string[] = [];
  let cursor: string | undefined;
  let done = false;

  while (!done) {
    const listResult = await env.CONFIG.list({
      prefix: 'product:',
      cursor,
    });

    for (const key of listResult.keys) {
      if (key.name.endsWith(':config')) {
        // Extract product ID from "product:<id>:config"
        const parts = key.name.split(':');
        if (parts.length >= 3) {
          productIds.push(parts[1]);
        }
      }
    }

    if (listResult.list_complete) {
      done = true;
    } else {
      cursor = listResult.cursor;
    }
  }

  // Always include "default" product even if not registered in KV
  if (!productIds.includes('default')) {
    productIds.unshift('default');
  }

  return productIds;
}

/**
 * Run weekly profile rebuild for all active users AND all active
 * standalone-agents across all products. Separated to use with
 * ctx.waitUntil() for extended execution time.
 *
 * User-scoped and agent-only profile pools are disjoint:
 *   - User run: rolls up all memories where user_id = U (including any
 *     that also carry an agent_id — those live under the user profile).
 *   - Agent run: rolls up only standalone-agent memories where
 *     agent_id = A AND user_id IS NULL.
 */
async function runWeeklyProfileRebuild(
  env: Env,
  productIds: string[],
  axiomConfig?: AxiomConfig,
): Promise<void> {
  const logCtx = Logger.createContext('consolidation', { step: 'cron:weekly-profile' });

  Logger.info(logCtx, 'Running weekly profile rebuild', {
    product_count: productIds.length,
  });

  for (const productId of productIds) {
    try {
      logCtx.product_id = productId;

      // Pool 1 — user-scoped profiles.
      const userIds = await env.DATA.memoryGetActiveUserIds(productId, 500);
      let userProfilesCreated = 0;
      for (const userId of userIds) {
        try {
          const result = await runProfileConsolidation(
            { user_id: userId },
            productId,
            env.DATA,
            claudeConfigFromEnv(env),
          );
          if (result.profile_created) userProfilesCreated++;
        } catch (error) {
          Logger.error(logCtx, 'Profile consolidation failed for user', {
            user_id: userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Pool 2 — standalone-agent profiles. Independent try/catch so
      // one pool's failures don't block the other.
      let agentProfilesCreated = 0;
      let agentIds: string[] = [];
      try {
        agentIds = await env.DATA.memoryGetActiveAgentIds(productId, 500);
      } catch (error) {
        Logger.error(logCtx, 'Failed to enumerate active agents', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      for (const agentId of agentIds) {
        try {
          const result = await runProfileConsolidation(
            { agent_id: agentId },
            productId,
            env.DATA,
            claudeConfigFromEnv(env),
          );
          if (result.profile_created) agentProfilesCreated++;
        } catch (error) {
          Logger.error(logCtx, 'Profile consolidation failed for agent', {
            agent_id: agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      Logger.info(logCtx, 'Profile rebuild complete for product', {
        user_profiles_created: userProfilesCreated,
        total_users: userIds.length,
        agent_profiles_created: agentProfilesCreated,
        total_agents: agentIds.length,
      });
    } catch (error) {
      Logger.error(logCtx, 'Profile rebuild failed for product', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (axiomConfig) {
    await Logger.flush(logCtx, axiomConfig);
  }
}

/**
 * Route a consolidation message to the appropriate job handler.
 */
async function processMessage(
  msg: ConsolidationMessage,
  env: Env,
  logCtx: LogContext,
): Promise<void> {
  const productId = msg.product_id;
  // Scope carries user_id and/or agent_id (validated by ConsolidationMessage).
  const scopeKeys = {
    user_id: msg.scope.user_id,
    agent_id: msg.scope.agent_id,
  };

  switch (msg.type) {
    case 'ingestion_complete': {
      if (msg.memory_ids && msg.memory_ids.length > 0) {
        const result = await runConflictResolution(
          scopeKeys,
          msg.memory_ids,
          env.DATA,
          productId,
          claudeConfigFromEnv(env),
        );
        Logger.info(logCtx, 'Conflict resolution complete', {
          job: 'conflict_resolution',
          conflicts_found: result.conflicts_found,
          resolved_count: result.resolved_count,
        });
      }
      break;
    }

    case 'profile_rebuild': {
      const result = await runProfileConsolidation(
        scopeKeys,
        productId,
        env.DATA,
        claudeConfigFromEnv(env),
      );
      Logger.info(logCtx, 'Profile consolidation complete', {
        job: 'profile_rebuild',
        profile_created: result.profile_created,
        facts_consolidated: result.facts_consolidated,
      });
      break;
    }

    case 'expiry_sweep': {
      const result = await runExpirySweep(env.DATA, productId);
      Logger.info(logCtx, 'Expiry sweep complete', {
        job: 'expiry_sweep',
        expired_count: result.expired_count,
      });
      break;
    }

    case 'confidence_decay': {
      const decayConfigJson = await env.CONFIG.get('consolidation:confidence_decay');
      const decayConfig = decayConfigJson ? JSON.parse(decayConfigJson) : undefined;
      const result = await runConfidenceDecay(env.DATA, productId, decayConfig);
      Logger.info(logCtx, 'Confidence decay complete', {
        job: 'confidence_decay',
        decayed_count: result.decayed_count,
        archived_count: result.archived_count,
      });
      break;
    }

    case 'conflict_resolution': {
      if (msg.memory_ids && msg.memory_ids.length > 0) {
        const result = await runConflictResolution(
          scopeKeys,
          msg.memory_ids,
          env.DATA,
          productId,
          claudeConfigFromEnv(env),
        );
        Logger.info(logCtx, 'Conflict resolution complete', {
          job: 'conflict_resolution',
          conflicts_found: result.conflicts_found,
          resolved_count: result.resolved_count,
        });
      }
      break;
    }

    default:
      Logger.warn(logCtx, 'Unknown message type', {
        type: String((msg as Record<string, unknown>).type),
      });
  }
}

/**
 * Handle a purge message. Validates the payload, runs the purge, and
 * manages queue ack/retry + terminal job status updates on failure.
 */
async function handlePurgeMessage(message: Message, env: Env, logCtx: LogContext): Promise<void> {
  const parsed = PurgeMessage.safeParse(message.body);
  if (!parsed.success) {
    Logger.error(logCtx, 'Invalid purge payload', {
      error: parsed.error.message,
    });
    await writeDeadLetter(env.DATA, 'default', message, 'Invalid purge payload');
    message.ack();
    return;
  }

  const { job_id, product_id, type, scope } = parsed.data;
  logCtx.product_id = product_id;
  if (scope?.user_id) logCtx.user_id = scope.user_id;
  if (scope?.agent_id) {
    (logCtx as Record<string, unknown>).agent_id = scope.agent_id;
  }

  try {
    Logger.info(logCtx, 'Running purge job', {
      job: 'purge',
      job_id,
      type,
    });
    const result = await runPurge(parsed.data, env.DATA, env.CONFIG);
    Logger.info(logCtx, 'Purge job complete', {
      job: 'purge',
      job_id,
      type,
      ...result,
    });
    message.ack();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    Logger.error(logCtx, 'Purge job failed', {
      job: 'purge',
      job_id,
      attempts: message.attempts,
      error: errMsg,
    });

    if (message.attempts >= 3) {
      // Terminal failure — mark the job record so status endpoint reflects
      // it, then dead-letter the message so ops can inspect/requeue.
      await markPurgeFailed(env.CONFIG, product_id, job_id, errMsg);
      await writeDeadLetter(env.DATA, product_id, message, errMsg);
      message.ack();
    } else {
      message.retry();
    }
  }
}

/**
 * Write a failed message to the dead_letters table.
 */
async function writeDeadLetter(
  data: Env['DATA'],
  productId: string,
  message: Message,
  errorMsg?: string,
): Promise<void> {
  const now = new Date().toISOString();

  await data.deadLetterCreate(productId, {
    id: crypto.randomUUID(),
    queue_name: 'consolidation',
    payload: JSON.stringify(message.body),
    error: errorMsg ?? `Failed after ${message.attempts} attempts`,
    attempts: message.attempts,
    first_failed_at: now,
    last_failed_at: now,
  });
}
