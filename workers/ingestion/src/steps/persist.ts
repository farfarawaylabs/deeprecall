import type { Scope, Memory, AuditAction, AuditTrigger } from '@deeprecall/types';
import type { MemoryCreateInput } from '@deeprecall/db';
import type { VectorMetadata, VectorUpsertItem } from '@deeprecall/vectorize';
import type { ReconcileDecision } from '../types';

/** The subset of DATA RPC methods used by the persist step. */
interface PersistData {
  memoryCreate(productId: string, input: MemoryCreateInput): Promise<Memory>;
  memoryGetById(productId: string, id: string): Promise<Memory | null>;
  memoryUpdateStatus(
    productId: string,
    id: string,
    status: string,
    superseded_by?: string,
  ): Promise<void>;
  vectorUpsertMany(productId: string, items: VectorUpsertItem[]): Promise<void>;
  vectorDeleteMany(productId: string, memoryIds: string[]): Promise<void>;
  auditLog(
    productId: string,
    action: AuditAction,
    memoryId: string,
    reason: string | null,
    oldValue: unknown | null,
    newValue: unknown | null,
    triggeredBy: AuditTrigger,
  ): Promise<void>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}

/**
 * Build Vectorize metadata for a candidate, omitting user_id/agent_id keys
 * when they're unset on the ingest scope. Vectorize filters cannot match
 * null — writing null poisons future filter queries.
 */
function buildVectorMetadata(
  scope: Scope,
  type: string,
  sourceType: string,
  confidence: number,
): VectorMetadata {
  const metadata: VectorMetadata = {
    type,
    status: 'active',
    source_type: sourceType,
    confidence,
  };
  if (scope.user_id) metadata.user_id = scope.user_id;
  if (scope.agent_id) metadata.agent_id = scope.agent_id;
  return metadata;
}

/**
 * Deterministic memory id: SHA-256 of (workflow instance, decision index),
 * formatted as a UUID. The persist step runs inside a retried Workflow
 * step — with random ids, a retry after a mid-loop failure re-created
 * every already-persisted memory under a fresh id (observed: ~25%
 * duplicate rows during a 250-session bulk import). Deterministic ids
 * make the retry converge on the same records instead.
 */
async function deterministicMemoryId(instanceId: string, index: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${instanceId}:${index}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Step 6: Persist approved memories to D1 and Vectorize via DATA service binding. */
export async function persist(
  decisions: ReconcileDecision[],
  scope: Scope,
  sourceChannel: string,
  data: PersistData,
  productId: string,
  instanceId: string,
  documentId: string | null = null,
): Promise<string[]> {
  const memoryIds: string[] = [];
  // Vector writes are collected and flushed in bulk after the D1 loop —
  // one Vectorize call per batch instead of one per memory. Bulk imports
  // were rate-limited (429, error 40041) by per-vector request volume,
  // erroring workflows and silently losing whole sessions. The step is
  // retried as a whole; deterministic ids + the existence guard make a
  // partial D1 loop converge on retry, and the vector flush is idempotent.
  const pendingUpserts: VectorUpsertItem[] = [];
  const pendingDeletes: string[] = [];
  const channel = sourceChannel as 'chat' | 'document' | 'api' | 'research' | 'manual';

  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (decision.action === 'skip') continue;

    const { candidate, embedding } = decision.candidate;
    const memoryId = await deterministicMemoryId(instanceId, i);
    const now = new Date().toISOString();

    // Retry-safety: if a prior attempt of this step already created this
    // memory, reuse it. Vector upserts and status updates below are
    // idempotent by id, so re-running them converges.
    const existing = await data.memoryGetById(productId, memoryId);

    if (decision.action === 'add') {
      const memory =
        existing ??
        (await data.memoryCreate(productId, {
          id: memoryId,
          content: candidate.content,
          episode: candidate.episode,
          type: candidate.type,
          status: 'active',
          user_id: scope.user_id ?? null,
          agent_id: scope.agent_id ?? null,
          session_id: scope.session_id ?? null,
          source_actor: candidate.source_actor,
          source_type: candidate.source_type,
          source_channel: channel,
          confidence: candidate.confidence,
          document_id: documentId,
          validity_start: candidate.validity_start,
          validity_end: candidate.validity_end,
          observed_at: now,
          tags: candidate.tags,
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
        }));

      pendingUpserts.push({
        memoryId,
        embedding,
        metadata: buildVectorMetadata(
          scope,
          candidate.type,
          candidate.source_type,
          candidate.confidence,
        ),
      });

      if (!existing) {
        await data.auditLog(
          productId,
          'created',
          memoryId,
          'Extracted from ingestion pipeline',
          null,
          memory,
          'ingestion_pipeline',
        );
      }

      memoryIds.push(memoryId);
    } else if (decision.action === 'supersede' && decision.existing_memory_id) {
      const oldMemory = await data.memoryGetById(productId, decision.existing_memory_id);

      // Create new memory FIRST (so the FK reference is valid)
      const memory =
        existing ??
        (await data.memoryCreate(productId, {
          id: memoryId,
          content: candidate.content,
          episode: candidate.episode,
          type: candidate.type,
          status: 'active',
          user_id: scope.user_id ?? null,
          agent_id: scope.agent_id ?? null,
          session_id: scope.session_id ?? null,
          source_actor: candidate.source_actor,
          source_type: candidate.source_type,
          source_channel: channel,
          confidence: candidate.confidence,
          document_id: documentId,
          validity_start: candidate.validity_start,
          validity_end: candidate.validity_end,
          observed_at: now,
          tags: candidate.tags,
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
        }));

      // Now mark old memory as superseded (FK to new memory is valid)
      await data.memoryUpdateStatus(productId, decision.existing_memory_id, 'superseded', memoryId);

      // Remove old vector (superseded memories shouldn't appear in search)
      pendingDeletes.push(decision.existing_memory_id);

      pendingUpserts.push({
        memoryId,
        embedding,
        metadata: buildVectorMetadata(
          scope,
          candidate.type,
          candidate.source_type,
          candidate.confidence,
        ),
      });

      // Audit: supersede old
      await data.auditLog(
        productId,
        'superseded',
        decision.existing_memory_id,
        decision.reason ?? 'Superseded by new ingestion',
        oldMemory,
        null,
        'ingestion_pipeline',
      );

      // Audit: create new
      if (!existing) {
        await data.auditLog(
          productId,
          'created',
          memoryId,
          `Superseded memory ${decision.existing_memory_id}`,
          null,
          memory,
          'ingestion_pipeline',
        );
      }

      memoryIds.push(memoryId);
    } else if (decision.action === 'merge' && decision.existing_memory_id) {
      const oldMemory = await data.memoryGetById(productId, decision.existing_memory_id);

      // Generate a fresh embedding for the merged content
      const mergedContent = decision.merged_content ?? candidate.content;
      let mergedEmbedding = embedding;
      if (decision.merged_content) {
        const embResult = await data.generateEmbeddings([mergedContent]);
        if (embResult[0]) {
          mergedEmbedding = embResult[0];
        }
      }

      // Create merged memory FIRST (so the FK reference is valid)
      const memory =
        existing ??
        (await data.memoryCreate(productId, {
          id: memoryId,
          content: mergedContent,
          episode: candidate.episode,
          type: candidate.type,
          status: 'active',
          user_id: scope.user_id ?? null,
          agent_id: scope.agent_id ?? null,
          session_id: scope.session_id ?? null,
          source_actor: candidate.source_actor,
          source_type: candidate.source_type,
          source_channel: channel,
          confidence: Math.max(candidate.confidence, oldMemory?.confidence ?? 0),
          document_id: documentId,
          validity_start: candidate.validity_start,
          validity_end: candidate.validity_end,
          observed_at: now,
          tags: candidate.tags,
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
        }));

      // Now mark old memory as superseded (FK to new memory is valid)
      await data.memoryUpdateStatus(productId, decision.existing_memory_id, 'superseded', memoryId);

      pendingDeletes.push(decision.existing_memory_id);

      pendingUpserts.push({
        memoryId,
        embedding: mergedEmbedding,
        metadata: buildVectorMetadata(
          scope,
          candidate.type,
          candidate.source_type,
          memory.confidence,
        ),
      });

      // Audit: merge old
      await data.auditLog(
        productId,
        'merged',
        decision.existing_memory_id,
        decision.reason ?? 'Merged with new ingestion',
        oldMemory,
        null,
        'ingestion_pipeline',
      );

      // Audit: create merged
      if (!existing) {
        await data.auditLog(
          productId,
          'created',
          memoryId,
          `Merged with memory ${decision.existing_memory_id}`,
          null,
          memory,
          'ingestion_pipeline',
        );
      }

      memoryIds.push(memoryId);
    }
  }

  // Flush vector writes in bulk (deletes first so a superseded id never
  // lingers past its replacement's upsert). Both calls are idempotent —
  // a step retry that re-enters here converges on the same state.
  if (pendingDeletes.length > 0) {
    await data.vectorDeleteMany(productId, pendingDeletes);
  }
  if (pendingUpserts.length > 0) {
    await data.vectorUpsertMany(productId, pendingUpserts);
  }

  return memoryIds;
}
