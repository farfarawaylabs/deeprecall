/**
 * Queue consumer semantics over the REAL handler, with dead letters landing
 * in REAL local D1.
 *
 * Drives `worker.queue()` (the exported default) with fake MessageBatch
 * objects whose ack()/retry() are spies, pinning:
 *   - per-message ack/retry (never ackAll/retryAll - one poison message
 *     must not requeue its batch-mates)
 *   - success acks; failure retries below the attempt cap; dead-letter +
 *     ack at attempts >= 3
 *   - invalid payloads dead-letter immediately (no retry can fix them)
 *   - the purge arm: KV job status transitions and product-scoped
 *     dead-letter writes
 *
 * The DATA facade is a real DataService over real D1 wherever the message
 * path touches storage; only failure triggers and the Vectorize arm are
 * stubs (no miniflare simulator for Vectorize; failures need determinism).
 */
import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
// Applies migrations and registers the per-test table wipe (see file header).
import '../apply-migrations';
import type { ConsolidationMessage, PurgeMessage } from '@deeprecall/types';
import { DataService } from '@deeprecall/worker-data';
import worker from '../../src/index';

const PRODUCT_ID = 'default';

type DataEnv = ConstructorParameters<typeof DataService>[1];

function makeRealService(): DataService {
  return new DataService(createExecutionContext(), {
    DB_default: env.DB_default,
  } as DataEnv);
}

interface FakeMessage {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function makeMessage(body: unknown, attempts = 1): FakeMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: FakeMessage[]) {
  return {
    queue: 'deeprecall-consolidation-queue-dev',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function makeEnv(data: unknown, config?: unknown): Env {
  return {
    DATA: data,
    CONFIG: config ?? makeMockKv(),
    AXIOM_API_TOKEN: '',
    AXIOM_DATASET: '',
  } as unknown as Env;
}

function makeMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function expirySweepMsg(overrides: Partial<ConsolidationMessage> = {}): ConsolidationMessage {
  return {
    type: 'expiry_sweep',
    product_id: PRODUCT_ID,
    scope: { user_id: 'user-a' },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function purgeMsg(jobId: string, overrides: Partial<PurgeMessage> = {}): PurgeMessage {
  return {
    kind: 'purge',
    type: 'purge_scoped',
    job_id: jobId,
    product_id: PRODUCT_ID,
    scope: { user_id: 'user-a' },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeInitialJobStatus(jobId: string): string {
  return JSON.stringify({
    job_id: jobId,
    product_id: PRODUCT_ID,
    type: 'purge_scoped',
    status: 'pending',
    scope: { user_id: 'user-a' },
    memories_deleted: 0,
    vectors_deleted: 0,
    audits_deleted: 0,
    documents_deleted: 0,
    r2_blobs_deleted: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
  });
}

async function runQueue(batch: ReturnType<typeof makeBatch>, testEnv: Env): Promise<void> {
  await worker.queue(batch as unknown as MessageBatch, testEnv);
}

describe('consolidation message path', () => {
  it('processes a valid message against real D1 and acks it', async () => {
    const service = makeRealService();
    // Seed an already-expired idempotency key so the expiry sweep has real
    // work to do - proof the job ran, not just that dispatch happened.
    await service.idempotencyStore(PRODUCT_ID, 'default:stale', '{"ok":true}', 24);
    await env.DB_default.prepare('UPDATE idempotency_keys SET expires_at = ? WHERE key = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), 'default:stale')
      .run();

    const message = makeMessage(expirySweepMsg());
    const batch = makeBatch([message]);
    await runQueue(batch, makeEnv(service));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    // The sweep actually deleted the expired key and nothing dead-lettered.
    const row = await env.DB_default.prepare('SELECT key FROM idempotency_keys WHERE key = ?')
      .bind('default:stale')
      .first();
    expect(row).toBeNull();
    expect(await service.deadLetterCount(PRODUCT_ID)).toBe(0);
  });

  it('dead-letters an invalid payload immediately and acks (no retry)', async () => {
    const service = makeRealService();
    const badBody = { type: 'not-a-real-type', product_id: PRODUCT_ID };
    const message = makeMessage(badBody, 1);
    await runQueue(makeBatch([message]), makeEnv(service));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const letters = await service.deadLetterList(PRODUCT_ID, 10);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      queue_name: 'consolidation',
      payload: JSON.stringify(badBody),
      error: 'Invalid message payload',
      attempts: 1,
    });
  });

  it('retries a failed message below the attempt cap without dead-lettering', async () => {
    const service = makeRealService();
    // product "other" has no DB binding, so the real service throws inside
    // the job - a genuine processing failure, not a stubbed one.
    const message = makeMessage(expirySweepMsg({ product_id: 'other' }), 1);
    await runQueue(makeBatch([message]), makeEnv(service));

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(await service.deadLetterCount(PRODUCT_ID)).toBe(0);
  });

  it('dead-letters into the DEFAULT product DB and acks once attempts reach 3', async () => {
    const service = makeRealService();
    const body = expirySweepMsg({ product_id: 'other' });
    const message = makeMessage(body, 3);
    await runQueue(makeBatch([message]), makeEnv(service));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    // Pinned: consolidation failures always dead-letter under the hard-coded
    // "default" product, even when the failing message belongs to another
    // product (the purge arm, by contrast, uses the message's product_id).
    const letters = await service.deadLetterList(PRODUCT_ID, 10);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      queue_name: 'consolidation',
      payload: JSON.stringify(body),
      error: 'Failed after 3 attempts',
      attempts: 3,
    });
  });

  it('handles each message independently - one poison message never drags down its batch-mates', async () => {
    const service = makeRealService();
    const good = makeMessage(expirySweepMsg());
    const poison = makeMessage(expirySweepMsg({ product_id: 'other' }), 1);
    const batch = makeBatch([poison, good]);
    await runQueue(batch, makeEnv(service));

    // Per-message semantics: the failure before `good` retries only itself,
    // and the batch-level helpers are never used.
    expect(poison.retry).toHaveBeenCalledOnce();
    expect(poison.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalledOnce();
    expect(good.retry).not.toHaveBeenCalled();
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(batch.retryAll).not.toHaveBeenCalled();
  });
});

describe('purge message path', () => {
  it('runs a scoped purge against real D1, completes the KV job, and acks', async () => {
    const service = makeRealService();
    const memory = await service.memoryCreate(PRODUCT_ID, {
      id: crypto.randomUUID(),
      content: 'User plays saxophone weekly',
      episode: null,
      type: 'fact',
      status: 'active',
      user_id: 'user-a',
      agent_id: null,
      session_id: null,
      source_actor: 'user',
      source_type: 'user_stated',
      source_channel: 'chat',
      confidence: 0.9,
      document_id: null,
      validity_start: null,
      validity_end: null,
      observed_at: new Date().toISOString(),
      tags: null,
      subject: null,
      predicate: null,
      object: null,
    });

    const jobId = 'job-queue-1';
    const kv = makeMockKv({ [`purge_job:${PRODUCT_ID}:${jobId}`]: makeInitialJobStatus(jobId) });
    const vectorDeleteMany = vi.fn().mockResolvedValue(undefined);
    const data = {
      memoryListIdsByScopeStrict: service.memoryListIdsByScopeStrict.bind(service),
      memoryDeleteByScope: service.memoryDeleteByScope.bind(service),
      auditDeleteByMemoryIds: service.auditDeleteByMemoryIds.bind(service),
      vectorDeleteMany,
    };

    const message = makeMessage(purgeMsg(jobId));
    await runQueue(makeBatch([message]), makeEnv(data, kv));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(vectorDeleteMany).toHaveBeenCalledWith(PRODUCT_ID, [memory.id]);
    expect(await service.memoryGetById(PRODUCT_ID, memory.id)).toBeNull();

    const stored = JSON.parse(kv.store.get(`purge_job:${PRODUCT_ID}:${jobId}`)!);
    expect(stored.status).toBe('completed');
    expect(stored.started_at).not.toBeNull();
    expect(stored.completed_at).not.toBeNull();
  });

  it('dead-letters an invalid purge payload immediately and acks', async () => {
    const service = makeRealService();
    const badBody = { kind: 'purge', type: 'purge_scoped' }; // missing job_id et al.
    const message = makeMessage(badBody, 1);
    await runQueue(makeBatch([message]), makeEnv(service));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const letters = await service.deadLetterList(PRODUCT_ID, 10);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      queue_name: 'consolidation',
      payload: JSON.stringify(badBody),
      error: 'Invalid purge payload',
    });
  });

  it('retries a failed purge below the attempt cap and leaves the job non-terminal', async () => {
    const jobId = 'job-queue-2';
    const kv = makeMockKv({ [`purge_job:${PRODUCT_ID}:${jobId}`]: makeInitialJobStatus(jobId) });
    const data = {
      memoryListIdsByScopeStrict: vi.fn().mockRejectedValue(new Error('D1 briefly unavailable')),
    };

    const message = makeMessage(purgeMsg(jobId), 1);
    await runQueue(makeBatch([message]), makeEnv(data, kv));

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    // The job was moved to "processing" before the failure and stays there
    // until a retry succeeds or attempts run out - never prematurely failed.
    const stored = JSON.parse(kv.store.get(`purge_job:${PRODUCT_ID}:${jobId}`)!);
    expect(stored.status).toBe('processing');
    expect(stored.error).toBeNull();
  });

  it('marks the job failed, dead-letters, and acks once purge attempts reach 3', async () => {
    const service = makeRealService();
    const jobId = 'job-queue-3';
    const kv = makeMockKv({ [`purge_job:${PRODUCT_ID}:${jobId}`]: makeInitialJobStatus(jobId) });
    const data = {
      memoryListIdsByScopeStrict: vi.fn().mockRejectedValue(new Error('vector cluster offline')),
      // Terminal path writes the dead letter through the real repository.
      deadLetterCreate: service.deadLetterCreate.bind(service),
    };

    const body = purgeMsg(jobId);
    const message = makeMessage(body, 3);
    await runQueue(makeBatch([message]), makeEnv(data, kv));

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    // Terminal KV state carries the failure for the status endpoint.
    const stored = JSON.parse(kv.store.get(`purge_job:${PRODUCT_ID}:${jobId}`)!);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('vector cluster offline');
    expect(stored.completed_at).not.toBeNull();

    // Dead letter carries the real error message (unlike the generic
    // consolidation path) and is scoped to the message's product_id.
    const letters = await service.deadLetterList(PRODUCT_ID, 10);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      queue_name: 'consolidation',
      payload: JSON.stringify(body),
      error: 'vector cluster offline',
      attempts: 3,
    });
  });
});
