import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { MemoryCandidate, ConsolidationMessage } from '@deeprecall/types';
import { claudeConfigFromEnv } from '@deeprecall/ai';
import type {
  IngestionPayload,
  ParseResult,
  EmbeddedCandidate,
  PolicyResult,
  ReconcileDecision,
  IngestionResult,
  IngestionRejection,
} from './types';

const PREVIEW_CHARS = 120;

function previewContent(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= PREVIEW_CHARS ? trimmed : `${trimmed.slice(0, PREVIEW_CHARS)}…`;
}
import { parseAndClassify } from './steps/parse-classify';
import { extract } from './steps/extract';
import { embed } from './steps/embed';
import { policyCheck } from './steps/policy-check';
import { reconcile } from './steps/reconcile';
import { persist } from './steps/persist';

/**
 * Retry envelopes. Steps that hit rate-limited services (Vectorize,
 * Workers AI, Anthropic) need a budget that outlasts a sustained 429
 * window — during a bulk import (e.g. onboarding a user's history),
 * concurrent workflows kept Vectorize rate-limited for minutes and the
 * old ~9s envelope (limit 2, 3-5s base) exhausted mid-window: 121
 * instances died AFTER successful extraction, silently losing whole
 * sessions. Workflows are durable — a long backoff costs nothing.
 * limit 6 @ 10s exponential ≈ 10 minutes of cumulative backoff.
 */
const RATE_LIMITED_STEP = {
  retries: { limit: 6, delay: '10 seconds', backoff: 'exponential' },
} as const;

export class IngestionWorkflow extends WorkflowEntrypoint<Env, IngestionPayload> {
  async run(event: WorkflowEvent<IngestionPayload>, step: WorkflowStep): Promise<IngestionResult> {
    try {
      return await this.pipeline(event, step);
    } catch (error) {
      // Terminal failure (a step exhausted its retries). Surface it in
      // dead_letters — before this, a dead workflow was invisible: the
      // ingest API had already returned the instance_id and nothing
      // recorded the loss.
      await this.deadLetter(event, step, error);
      throw error;
    }
  }

  private async deadLetter(
    event: WorkflowEvent<IngestionPayload>,
    step: WorkflowStep,
    error: unknown,
  ): Promise<void> {
    const payload = event.payload;
    try {
      // A step (durable, exactly-once on replay) with an id derived from
      // the instance: an engine replay of the failed run converges on one
      // dead-letter row instead of inserting a new one per execution.
      await step.do('dead-letter', async () => {
        const now = new Date().toISOString();
        await this.env.DATA.deadLetterCreate(payload.product_id, {
          id: `ingestion-${event.instanceId}`,
          queue_name: 'ingestion',
          // Full payload so ops can re-submit the ingest verbatim.
          payload: JSON.stringify({
            ...payload,
            workflow_instance_id: event.instanceId,
          }),
          error: error instanceof Error ? error.message : String(error),
          // The failing step ran its full envelope: 1 + retry limit.
          attempts: RATE_LIMITED_STEP.retries.limit + 1,
          first_failed_at: now,
          last_failed_at: now,
        });
      });
    } catch {
      // Best effort (e.g. the row already exists from a prior replay) —
      // never mask the original workflow error.
    }
  }

  private async pipeline(
    event: WorkflowEvent<IngestionPayload>,
    step: WorkflowStep,
  ): Promise<IngestionResult> {
    const payload = event.payload;
    const env = this.env;

    // Step 1: Parse & Classify
    const parseResult = await step.do('parse-and-classify', async (): Promise<ParseResult> => {
      return parseAndClassify(payload, env.CONFIG);
    });

    // Step 2: Extract memories via LLM
    const candidates = await step.do(
      'extract-memories',
      RATE_LIMITED_STEP,
      async (): Promise<MemoryCandidate[]> => {
        return extract(parseResult, claudeConfigFromEnv(env));
      },
    );

    if (candidates.length === 0) {
      return {
        memory_ids: [],
        candidates_extracted: 0,
        candidates_approved: 0,
        candidates_persisted: 0,
        rejections: [],
      };
    }

    // Step 3: Generate embeddings via DATA service binding
    const embedded = await step.do(
      'generate-embeddings',
      RATE_LIMITED_STEP,
      async (): Promise<EmbeddedCandidate[]> => {
        return embed(candidates, env.DATA);
      },
    );

    // Step 4: Policy check
    const policyResult = await step.do('policy-check', async (): Promise<PolicyResult> => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      // Rate-limit counts are strict per principal. When both user_id
      // and agent_id are set, count by user_id (more restrictive —
      // prevents cross-agent flooding of a single user). When only
      // agent_id is set, count by agent_id.
      const rateLimitScope = payload.scope.user_id
        ? { user_id: payload.scope.user_id }
        : { agent_id: payload.scope.agent_id! };

      const memoriesThisPeriod = await env.DATA.memoryCountCreatedSince(
        payload.product_id,
        rateLimitScope,
        oneHourAgo,
      );

      // Load product-specific policy overrides from KV
      const overridesJson = await env.CONFIG.get(`product:${payload.product_id}:policy_overrides`);
      const overrides = overridesJson ? JSON.parse(overridesJson) : undefined;

      return policyCheck(
        embedded,
        {
          product_id: payload.product_id,
          user_id: payload.scope.user_id,
          agent_id: payload.scope.agent_id,
          memories_created_this_period: memoriesThisPeriod,
        },
        overrides,
      );
    });

    const policyRejections: IngestionRejection[] = policyResult.rejected.map((r) => ({
      step: 'policy' as const,
      content_preview: previewContent(r.candidate.content),
      reason: r.reason,
    }));

    if (policyResult.approved.length === 0) {
      return {
        memory_ids: [],
        candidates_extracted: candidates.length,
        candidates_approved: 0,
        candidates_persisted: 0,
        rejections: policyRejections,
      };
    }

    // Step 5: Reconcile — compare candidates against existing memories
    const decisions = await step.do(
      'reconcile',
      RATE_LIMITED_STEP,
      async (): Promise<ReconcileDecision[]> => {
        return reconcile(policyResult.approved, {
          data: env.DATA,
          productId: payload.product_id,
          claude: claudeConfigFromEnv(env),
          scope: payload.scope,
        });
      },
    );

    // Step 6: Persist to D1 + Vectorize via DATA service binding
    const memoryIds = await step.do('persist', RATE_LIMITED_STEP, async (): Promise<string[]> => {
      return persist(
        decisions,
        payload.scope,
        payload.source_channel,
        env.DATA,
        payload.product_id,
        event.instanceId,
        payload.document_id ?? null,
      );
    });

    // Step 7: Enqueue consolidation message
    if (memoryIds.length > 0) {
      await step.do('enqueue-consolidation', async () => {
        const message: ConsolidationMessage = {
          type: 'ingestion_complete',
          product_id: payload.product_id,
          scope: payload.scope,
          memory_ids: memoryIds,
          triggered_by: 'ingestion_pipeline',
          created_at: new Date().toISOString(),
        };
        await env.CONSOLIDATION_QUEUE.send(message);
      });
    }

    // Reconcile SKIPs are also useful to surface (duplicate detection,
    // pinned-memory conflicts). The LLM or auto-skip path populates reason.
    const reconcileSkips: IngestionRejection[] = decisions
      .filter((d) => d.action === 'skip')
      .map((d) => ({
        step: 'reconcile' as const,
        content_preview: previewContent(d.candidate.candidate.content),
        reason: d.reason ?? 'Skipped without reason',
      }));

    return {
      memory_ids: memoryIds,
      candidates_extracted: candidates.length,
      candidates_approved: policyResult.approved.length,
      candidates_persisted: memoryIds.length,
      rejections: [...policyRejections, ...reconcileSkips],
    };
  }
}
