import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  Memory,
  MemoryStatus,
  SourceType,
  AuditAction,
  AuditTrigger,
  Document,
} from '@deeprecall/types';
import {
  D1MemoryRepository,
  D1AuditRepository,
  D1IdempotencyRepository,
  D1DeadLetterRepository,
  D1DocumentRepository,
} from '@deeprecall/db';
import type {
  MemoryCreateInput,
  MemoryListFilters,
  PaginationParams,
  PaginatedResult,
  AuditEntry,
  DeadLetterEntry,
  DocumentCreateInput,
  DocumentUpdateInput,
  DocumentListFilters,
  DocumentCleanupRef,
  ScopeKeys,
} from '@deeprecall/db';
import { CloudflareVectorizeService } from '@deeprecall/vectorize';
import type {
  VectorMetadata,
  VectorSearchResult,
  VectorSearchFilters,
  VectorUpsertItem,
} from '@deeprecall/vectorize';

/**
 * Local Env type for the data worker. Declared explicitly (not using
 * the ambient global `Env`) so that other workers can import DataService
 * for typed RPC without ambient type conflicts.
 */
interface DataWorkerEnv {
  CONFIG: KVNamespace;
  DOCUMENTS_BUCKET: R2Bucket;
  AI: Ai;
  // Static product bindings — new products add DB_<slug> / VEC_<slug> here
  DB_default: D1Database;
  VEC_default: VectorizeIndex;
  // Allow dynamic binding access for multi-product routing
  [key: string]: unknown;
}

/**
 * DataService — Central data access layer for Deep Recall.
 *
 * All storage bindings (D1, Vectorize, R2) live here. Other workers
 * call these methods via Service Binding RPC (zero-latency, in-process).
 *
 * When a new product is onboarded, only this worker needs updated
 * bindings + redeployment.
 */
export class DataService extends WorkerEntrypoint<DataWorkerEnv> {
  // ─── Product → Binding Resolution ──────────────────────────

  private getD1(productId: string): D1Database {
    const bindingName = `DB_${productId}`;
    const db = this.env[bindingName] as D1Database | undefined;
    if (!db) {
      throw new Error(
        `No D1 binding found for product "${productId}" (expected binding "${bindingName}")`,
      );
    }
    return db;
  }

  private getVectorize(productId: string): VectorizeIndex {
    const bindingName = `VEC_${productId}`;
    const vec = this.env[bindingName] as VectorizeIndex | undefined;
    if (!vec) {
      throw new Error(
        `No Vectorize binding found for product "${productId}" (expected binding "${bindingName}")`,
      );
    }
    return vec;
  }

  // ─── Memory Repository ─────────────────────────────────────

  async memoryCreate(productId: string, input: MemoryCreateInput): Promise<Memory> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.create(input);
  }

  async memoryGetById(productId: string, id: string): Promise<Memory | null> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.getById(id);
  }

  async memoryGetByIds(productId: string, ids: string[]): Promise<Memory[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.getByIds(ids);
  }

  async memoryListByScope(
    productId: string,
    filters: MemoryListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Memory>> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.listByScope(filters, pagination);
  }

  async memoryUpdateStatus(
    productId: string,
    id: string,
    status: MemoryStatus,
    superseded_by?: string,
  ): Promise<void> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.updateStatus(id, status, superseded_by);
  }

  /**
   * FTS5 search with relaxed scope match (null on memory passes).
   */
  async memorySearch(
    productId: string,
    query: string,
    scope: ScopeKeys,
    limit: number,
  ): Promise<Memory[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.search(query, scope, limit);
  }

  /**
   * Strict scope delete — null on memory does NOT match. Requires at least
   * one of user_id/agent_id.
   */
  async memoryDeleteByScope(productId: string, scope: ScopeKeys): Promise<number> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.deleteByScope(scope);
  }

  /** Strict scope count for rate-limiting. */
  async memoryCountCreatedSince(
    productId: string,
    scope: ScopeKeys,
    since: string,
  ): Promise<number> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.countCreatedSince(scope, since);
  }

  async memoryUpdateConfidenceAndSourceType(
    productId: string,
    id: string,
    confidence: number,
    source_type: SourceType,
  ): Promise<void> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.updateConfidenceAndSourceType(id, confidence, source_type);
  }

  async memoryFindStaleMemories(
    productId: string,
    notUpdatedSince: string,
    limit: number,
  ): Promise<Memory[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.findStaleMemories(notUpdatedSince, limit);
  }

  async memoryUpdateConfidence(productId: string, id: string, confidence: number): Promise<void> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.updateConfidence(id, confidence);
  }

  /**
   * Find active fact memories for profile consolidation. Strict match with
   * disjoint-pool rule — user run selects user-scoped memories, agent run
   * selects standalone-agent memories (user_id IS NULL).
   */
  async memoryFindFactsForProfile(
    productId: string,
    scope: ScopeKeys,
    minConfidence: number,
    limit: number,
  ): Promise<Memory[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.findFactsForProfile(scope, minConfidence, limit);
  }

  async memoryGetActiveUserIds(productId: string, limit: number): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.getActiveUserIds(limit);
  }

  /**
   * List distinct agent_ids for standalone-agent memories (user_id IS NULL).
   * Used by the weekly profile rebuild cron to consolidate agent-only profiles.
   */
  async memoryGetActiveAgentIds(productId: string, limit: number): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.getActiveAgentIds(limit);
  }

  /**
   * List memory IDs matching a strict scope (null on memory does NOT match).
   * Lightweight vs memoryListByScope — returns just IDs. Used by scoped
   * purge to collect vector/audit cleanup targets.
   */
  async memoryListIdsByScopeStrict(
    productId: string,
    scope: ScopeKeys,
    limit: number,
  ): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.listIdsByScopeStrict(scope, limit);
  }

  /**
   * List every memory ID in the product regardless of status. Used by
   * product-wide purge.
   */
  async memoryListAllIds(productId: string, limit: number): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.listAllIds(limit);
  }

  /**
   * Delete every memory in the product. Returns rows affected. Intended
   * for product-wide purge jobs; destructive and irreversible.
   */
  async memoryDeleteAll(productId: string): Promise<number> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.deleteAll();
  }

  /**
   * List IDs of memories tied to a specific document. Used by the
   * single-document delete flow to cascade cleanup.
   */
  async memoryListIdsByDocumentId(
    productId: string,
    documentId: string,
    limit: number,
  ): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.listIdsByDocumentId(documentId, limit);
  }

  /**
   * Delete all memories tied to a specific document. Caller must delete
   * vectors/audit rows first. Returns rows affected.
   */
  async memoryDeleteByDocumentId(productId: string, documentId: string): Promise<number> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.deleteByDocumentId(documentId);
  }

  /**
   * List IDs of every memory attached to any document. Used by the
   * document-wide purge to collect cascade targets.
   */
  async memoryListIdsWithAnyDocument(productId: string, limit: number): Promise<string[]> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.listIdsWithAnyDocument(limit);
  }

  /**
   * Delete every memory tied to any document in one SQL statement.
   * Used by the product-wide documents purge after vector/audit cleanup.
   */
  async memoryDeleteAllWithDocument(productId: string): Promise<number> {
    const repo = new D1MemoryRepository(this.getD1(productId));
    return repo.deleteAllWithDocument();
  }

  // ─── Audit Repository ──────────────────────────────────────

  async auditLog(
    productId: string,
    action: AuditAction,
    memoryId: string,
    reason: string | null,
    oldValue: unknown | null,
    newValue: unknown | null,
    triggeredBy: AuditTrigger,
  ): Promise<void> {
    const repo = new D1AuditRepository(this.getD1(productId));
    return repo.log(action, memoryId, reason, oldValue, newValue, triggeredBy);
  }

  async auditGetByMemoryId(productId: string, memoryId: string): Promise<AuditEntry[]> {
    const repo = new D1AuditRepository(this.getD1(productId));
    return repo.getByMemoryId(memoryId);
  }

  async auditListRecent(productId: string, scope: ScopeKeys, limit: number): Promise<AuditEntry[]> {
    const repo = new D1AuditRepository(this.getD1(productId));
    return repo.listRecent(scope, limit);
  }

  async auditDeleteByMemoryIds(productId: string, memoryIds: string[]): Promise<number> {
    const repo = new D1AuditRepository(this.getD1(productId));
    return repo.deleteByMemoryIds(memoryIds);
  }

  // ─── Idempotency Repository ────────────────────────────────

  async idempotencyCheck(productId: string, key: string): Promise<string | null> {
    const repo = new D1IdempotencyRepository(this.getD1(productId));
    return repo.check(key);
  }

  async idempotencyStore(
    productId: string,
    key: string,
    response: string,
    ttlHours: number,
  ): Promise<void> {
    const repo = new D1IdempotencyRepository(this.getD1(productId));
    return repo.store(key, response, ttlHours);
  }

  async idempotencyCleanup(productId: string): Promise<number> {
    const repo = new D1IdempotencyRepository(this.getD1(productId));
    return repo.cleanup();
  }

  // ─── Dead Letter Repository ────────────────────────────────

  async deadLetterCreate(productId: string, entry: DeadLetterEntry): Promise<void> {
    const repo = new D1DeadLetterRepository(this.getD1(productId));
    return repo.create(entry);
  }

  async deadLetterGetById(productId: string, id: string): Promise<DeadLetterEntry | null> {
    const repo = new D1DeadLetterRepository(this.getD1(productId));
    return repo.getById(id);
  }

  async deadLetterList(productId: string, limit: number): Promise<DeadLetterEntry[]> {
    const repo = new D1DeadLetterRepository(this.getD1(productId));
    return repo.list(limit);
  }

  async deadLetterCount(productId: string): Promise<number> {
    const repo = new D1DeadLetterRepository(this.getD1(productId));
    return repo.count();
  }

  async deadLetterDeleteById(productId: string, id: string): Promise<void> {
    const repo = new D1DeadLetterRepository(this.getD1(productId));
    return repo.deleteById(id);
  }

  // ─── Vectorize Service ─────────────────────────────────────

  async vectorUpsert(
    productId: string,
    memoryId: string,
    embedding: number[],
    metadata: VectorMetadata,
  ): Promise<void> {
    const svc = new CloudflareVectorizeService(this.getVectorize(productId));
    return svc.upsert(memoryId, embedding, metadata);
  }

  async vectorUpsertMany(productId: string, items: VectorUpsertItem[]): Promise<void> {
    const svc = new CloudflareVectorizeService(this.getVectorize(productId));
    return svc.upsertMany(items);
  }

  async vectorSearch(
    productId: string,
    embedding: number[],
    filters: VectorSearchFilters,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    const svc = new CloudflareVectorizeService(this.getVectorize(productId));
    return svc.search(embedding, filters, topK);
  }

  async vectorDelete(productId: string, memoryId: string): Promise<void> {
    const svc = new CloudflareVectorizeService(this.getVectorize(productId));
    return svc.delete(memoryId);
  }

  async vectorDeleteMany(productId: string, memoryIds: string[]): Promise<void> {
    const svc = new CloudflareVectorizeService(this.getVectorize(productId));
    return svc.deleteMany(memoryIds);
  }

  // ─── Document Repository ────────────────────────────────────

  async documentRecordCreate(productId: string, input: DocumentCreateInput): Promise<Document> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.create(input);
  }

  async documentRecordGetById(productId: string, id: string): Promise<Document | null> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.getById(id);
  }

  async documentRecordDeleteById(productId: string, id: string): Promise<void> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.deleteById(id);
  }

  async documentRecordList(
    productId: string,
    filters: DocumentListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Document>> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.list(filters, pagination);
  }

  async documentRecordUpdate(
    productId: string,
    id: string,
    input: DocumentUpdateInput,
  ): Promise<Document> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.update(id, input);
  }

  async documentRecordListCleanupRefsByScope(
    productId: string,
    scope: ScopeKeys,
    limit: number,
  ): Promise<DocumentCleanupRef[]> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.listCleanupRefsByScope(scope, limit);
  }

  async documentRecordListAllCleanupRefs(
    productId: string,
    limit: number,
  ): Promise<DocumentCleanupRef[]> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.listAllCleanupRefs(limit);
  }

  async documentRecordDeleteByScope(productId: string, scope: ScopeKeys): Promise<number> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.deleteByScope(scope);
  }

  async documentRecordDeleteAll(productId: string): Promise<number> {
    const repo = new D1DocumentRepository(this.getD1(productId));
    return repo.deleteAll();
  }

  // ─── R2 Document Storage ───────────────────────────────────

  async documentUpload(key: string, body: ArrayBuffer, contentType: string): Promise<void> {
    await this.env.DOCUMENTS_BUCKET.put(key, body, {
      httpMetadata: { contentType },
    });
  }

  async documentDownload(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const obj = await this.env.DOCUMENTS_BUCKET.get(key);
    if (!obj) return null;
    const body = await obj.arrayBuffer();
    const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
    return { body, contentType };
  }

  async documentDelete(key: string): Promise<void> {
    await this.env.DOCUMENTS_BUCKET.delete(key);
  }

  /**
   * Delete many R2 objects by explicit key list. Returns the number attempted —
   * R2 `delete([keys])` is idempotent and does not surface per-key failures.
   */
  async documentDeleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    // R2 batch delete accepts up to 1000 keys per call.
    const BATCH = 1000;
    for (let i = 0; i < keys.length; i += BATCH) {
      await this.env.DOCUMENTS_BUCKET.delete(keys.slice(i, i + BATCH));
    }
    return keys.length;
  }

  /**
   * Delete all R2 objects under a given prefix (e.g., "my-product/documents/").
   * Returns the number of objects deleted.
   */
  async documentDeleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;
    let done = false;

    while (!done) {
      const listed = await this.env.DOCUMENTS_BUCKET.list({
        prefix,
        cursor,
      });

      if (listed.objects.length > 0) {
        const keys = listed.objects.map((obj) => obj.key);
        await this.env.DOCUMENTS_BUCKET.delete(keys);
        deleted += keys.length;
      }

      if (listed.truncated) {
        cursor = listed.cursor;
      } else {
        done = true;
      }
    }

    return deleted;
  }

  // ─── Workers AI (Embeddings) ───────────────────────────────

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const result = await this.env.AI.run('@cf/baai/bge-m3', {
      text: texts,
    });
    const embeddings = 'data' in result && result.data ? result.data : [];
    return embeddings;
  }

  // ─── Workers AI (Reranking) ────────────────────────────────

  /**
   * Cross-encoder relevance scores for query/text pairs, one batched
   * inference. Returns a score in [0, 1] per input text (sigmoid over the
   * model's raw logits), aligned by index with the input array.
   */
  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const result = await this.env.AI.run('@cf/baai/bge-reranker-base', {
      query,
      contexts: texts.map((text) => ({ text })),
    });
    const rows: { id?: number; score?: number }[] =
      'response' in result && Array.isArray(result.response) ? result.response : [];
    const scores = new Array<number>(texts.length).fill(0);
    for (const row of rows) {
      if (row.id !== undefined && row.score !== undefined) {
        scores[row.id] = 1 / (1 + Math.exp(-row.score));
      }
    }
    return scores;
  }
}

// Default export handles direct HTTP requests (health check only)
export default {
  async fetch(request: Request, _env: DataWorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'data',
        timestamp: new Date().toISOString(),
      });
    }
    return new Response('Not Found', { status: 404 });
  },
};
