import type { CorrectionRequest, Memory } from '@deeprecall/types';
import { authorizeScope } from '../auth/scope-check';
import { CorrectionRequestError } from './errors';

export interface CorrectionsContext {
  env: Env;
  productId: string;
}

/** Response body for POST /v1/correct. */
export interface CorrectionResult {
  action: CorrectionRequest['action'];
  memory_id: string;
  new_memory_id: string | null;
  message: string;
}

/**
 * The three "turn it off" actions differ only in the status they set, the
 * audit action they record, and the default reason. All remove the memory
 * from Vectorize so it stops surfacing in retrieval.
 */
const DEACTIVATIONS = {
  suppress: {
    status: 'suppressed',
    auditAction: 'suppressed',
    defaultReason: 'User-initiated suppression',
  },
  expire: {
    status: 'expired',
    auditAction: 'expired',
    defaultReason: 'User-initiated expiry',
  },
  // Soft delete: archived in D1, removed from Vectorize.
  delete: {
    status: 'archived',
    auditAction: 'deleted',
    defaultReason: 'User-initiated deletion',
  },
} as const;

const ACTION_PAST_TENSE: Record<CorrectionRequest['action'], string> = {
  suppress: 'suppressed',
  expire: 'expired',
  delete: 'deleted',
  pin: 'pinned',
  update: 'updated',
};

/**
 * Vectorize metadata for a memory being pinned or corrected: confidence 1.0
 * and source_type user_stated (both actions express explicit user intent).
 * Scope keys are attached only when present — Vectorize metadata cannot
 * hold nulls.
 */
function userStatedVectorMetadata(memory: Memory, status: string) {
  const metadata: {
    user_id?: string;
    agent_id?: string;
    type: string;
    status: string;
    source_type: string;
    confidence: number;
  } = {
    type: memory.type,
    status,
    source_type: 'user_stated',
    confidence: 1.0,
  };
  if (memory.user_id) metadata.user_id = memory.user_id;
  if (memory.agent_id) metadata.agent_id = memory.agent_id;
  return metadata;
}

/** suppress / expire / delete: set the terminal status and drop the vector. */
async function deactivateMemory(
  action: keyof typeof DEACTIVATIONS,
  memory: Memory,
  reason: string | undefined,
  ctx: CorrectionsContext,
): Promise<void> {
  const spec = DEACTIVATIONS[action];
  await ctx.env.DATA.memoryUpdateStatus(ctx.productId, memory.id, spec.status);
  await ctx.env.DATA.vectorDelete(ctx.productId, memory.id);
  await ctx.env.DATA.auditLog(
    ctx.productId,
    spec.auditAction,
    memory.id,
    reason ?? spec.defaultReason,
    memory,
    null,
    'user_correction',
  );
}

/**
 * pin: confidence 1.0 + source_type user_stated, making the memory immune
 * to auto-supersede in reconciliation. Vectorize metadata is refreshed via
 * a re-embed; if embedding fails the D1 pin still stands (metadata refresh
 * is best-effort, matching the original handler).
 */
async function pinMemory(
  memory: Memory,
  reason: string | undefined,
  ctx: CorrectionsContext,
): Promise<void> {
  await ctx.env.DATA.memoryUpdateConfidenceAndSourceType(
    ctx.productId,
    memory.id,
    1.0,
    'user_stated',
  );
  await ctx.env.DATA.auditLog(
    ctx.productId,
    'corrected',
    memory.id,
    reason ?? 'User pinned memory',
    memory,
    { ...memory, confidence: 1.0, source_type: 'user_stated' },
    'user_correction',
  );
  // Update Vectorize metadata to reflect the new confidence — requires a
  // re-embed of the content via the DATA service.
  const embeddings = await ctx.env.DATA.generateEmbeddings([memory.content]);
  const embedding = embeddings[0] ?? null;
  if (embedding) {
    await ctx.env.DATA.vectorUpsert(
      ctx.productId,
      memory.id,
      embedding,
      userStatedVectorMetadata(memory, memory.status),
    );
  }
}

/**
 * update: supersede the old memory with corrected content + a new embedding.
 * The new memory is created BEFORE the old one is marked superseded — the
 * superseded_by column carries a foreign key to the new row, and D1 enforces
 * it strictly (create-before-supersede invariant).
 */
async function updateMemory(
  memory: Memory,
  updatedContent: string,
  reason: string | undefined,
  ctx: CorrectionsContext,
): Promise<string> {
  const newMemoryId = crypto.randomUUID();
  const now = new Date().toISOString();

  const updateEmbeddings = await ctx.env.DATA.generateEmbeddings([updatedContent]);
  const updateEmbedding = updateEmbeddings[0] ?? null;
  if (!updateEmbedding) {
    throw new CorrectionRequestError(
      'Failed to generate embedding for updated content',
      500,
      'INTERNAL_ERROR',
    );
  }

  // Create new memory with corrected content
  const newMemory = await ctx.env.DATA.memoryCreate(ctx.productId, {
    id: newMemoryId,
    content: updatedContent,
    episode: memory.episode,
    type: memory.type,
    status: 'active',
    user_id: memory.user_id,
    agent_id: memory.agent_id,
    session_id: memory.session_id,
    source_actor: memory.source_actor,
    source_type: 'user_stated',
    source_channel: memory.source_channel,
    confidence: 1.0,
    document_id: memory.document_id,
    validity_start: memory.validity_start,
    validity_end: memory.validity_end,
    observed_at: now,
    tags: memory.tags,
    subject: memory.subject,
    predicate: memory.predicate,
    object: memory.object,
  });

  // Now mark old as superseded (FK to new memory is valid)
  await ctx.env.DATA.memoryUpdateStatus(ctx.productId, memory.id, 'superseded', newMemoryId);
  await ctx.env.DATA.vectorDelete(ctx.productId, memory.id);

  await ctx.env.DATA.vectorUpsert(
    ctx.productId,
    newMemoryId,
    updateEmbedding,
    userStatedVectorMetadata(memory, 'active'),
  );

  // Audit: supersede old
  await ctx.env.DATA.auditLog(
    ctx.productId,
    'superseded',
    memory.id,
    reason ?? 'Superseded by user correction',
    memory,
    null,
    'user_correction',
  );

  // Audit: create new
  await ctx.env.DATA.auditLog(
    ctx.productId,
    'corrected',
    newMemoryId,
    `Corrected version of memory ${memory.id}`,
    null,
    newMemory,
    'user_correction',
  );

  return newMemoryId;
}

/**
 * Apply a user correction to a memory. Fetches the target, enforces scope
 * ownership, then dispatches on the action. Throws CorrectionRequestError
 * for every caller-visible failure.
 */
export async function applyCorrection(
  req: CorrectionRequest,
  ctx: CorrectionsContext,
): Promise<CorrectionResult> {
  const { memory_id, action, reason, updated_content } = req;

  const memory = await ctx.env.DATA.memoryGetById(ctx.productId, memory_id);
  if (!memory) {
    throw new CorrectionRequestError(`Memory ${memory_id} not found`, 404, 'NOT_FOUND');
  }

  // Authorization: caller must not contradict the memory's scope AND must
  // positively match at least one non-null scope field. See authorizeScope.
  if (!authorizeScope(memory, req.scope)) {
    throw new CorrectionRequestError(
      'Memory does not belong to the specified scope',
      403,
      'AUTHENTICATION_ERROR',
    );
  }

  let newMemoryId: string | null = null;

  switch (action) {
    case 'suppress':
    case 'expire':
    case 'delete':
      await deactivateMemory(action, memory, reason, ctx);
      break;
    case 'pin':
      await pinMemory(memory, reason, ctx);
      break;
    case 'update':
      // updated_content presence is enforced by the CorrectionRequest schema refine.
      newMemoryId = await updateMemory(memory, updated_content!, reason, ctx);
      break;
  }

  return {
    action,
    memory_id,
    new_memory_id: newMemoryId,
    message: `Memory ${memory_id} ${ACTION_PAST_TENSE[action]} successfully`,
  };
}
