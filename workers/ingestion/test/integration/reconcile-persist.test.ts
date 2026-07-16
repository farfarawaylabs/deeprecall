/**
 * Reconciliation E2E over REAL local D1.
 *
 * The mock-based suites in test/steps/ pin the decision logic; this suite
 * pins that the reconcile → persist pipeline actually converges on correct
 * rows in a real database: FK ordering for the supersede chain, FTS trigger
 * maintenance, audit rows, and deterministic-id retry convergence.
 *
 * Vectorize and Workers AI have no miniflare simulator, so the vector/embedding
 * arms are vi.fn stubs injected at the same interface boundary the workflow
 * uses. Everything D1-shaped runs through the real DataService repositories.
 */
import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Applies migrations and registers the per-test table wipe (see file header).
import '../apply-migrations';
import type { MemoryCandidate, Scope } from '@deeprecall/types';
import type { MemoryCreateInput } from '@deeprecall/db';
import { DataService } from '@deeprecall/worker-data';
import type { EmbeddedCandidate, ReconcileDecision } from '../../src/types';
import type { ReconcileEnv } from '../../src/steps/reconcile';

// Mock ONLY the LLM arm of @deeprecall/ai; every other export stays real.
vi.mock('@deeprecall/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deeprecall/ai')>();
  return { ...actual, reconcileCandidate: vi.fn() };
});

import { reconcile } from '../../src/steps/reconcile';
import { persist } from '../../src/steps/persist';
import { reconcileCandidate } from '@deeprecall/ai';

const mockReconcileCandidate = vi.mocked(reconcileCandidate);

const PRODUCT_ID = 'default';
const SCOPE: Scope = { user_id: 'user-a' };

// Deterministic embeddings: reconcile's D1 recent-memory arm computes cosine
// similarity between these, so orthogonal vs identical vectors let tests
// steer the pipeline without any real embedding model.
const CANDIDATE_EMBEDDING = [1, 0, 0];
const ORTHOGONAL_EMBEDDING = [0, 1, 0];

type DataEnv = ConstructorParameters<typeof DataService>[1];

function makeHarness() {
  // Direct construction (not RPC) so we can hand it a partial env: only the
  // real D1 binding. Vector/AI methods are never reached — the pipeline is
  // driven through the `data` facade below, which stubs those arms.
  const service = new DataService(createExecutionContext(), {
    DB_default: env.DB_default,
  } as DataEnv);

  const stubs = {
    vectorSearch: vi.fn().mockResolvedValue([] as { memory_id: string; score: number }[]),
    generateEmbeddings: vi.fn().mockResolvedValue([] as number[][]),
    vectorUpsertMany: vi.fn().mockResolvedValue(undefined),
    vectorDeleteMany: vi.fn().mockResolvedValue(undefined),
  };

  // The exact method surface reconcile + persist consume: D1-backed methods
  // are the real repositories over real D1; Vectorize/AI arms are stubs.
  const data = {
    memoryCreate: service.memoryCreate.bind(service),
    memoryGetById: service.memoryGetById.bind(service),
    memoryGetByIds: service.memoryGetByIds.bind(service),
    memoryListByScope: service.memoryListByScope.bind(service),
    memoryUpdateStatus: service.memoryUpdateStatus.bind(service),
    auditLog: service.auditLog.bind(service),
    ...stubs,
  };

  return { service, data, stubs };
}

function makeReconcileEnv(data: ReturnType<typeof makeHarness>['data']): ReconcileEnv {
  return {
    data,
    productId: PRODUCT_ID,
    claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
    scope: SCOPE,
  };
}

function makeEmbeddedCandidate(overrides: Partial<MemoryCandidate> = {}): EmbeddedCandidate {
  return {
    candidate: {
      content: 'User prefers TypeScript for backend work',
      episode: null,
      type: 'fact',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 0.9,
      validity_start: null,
      validity_end: null,
      tags: [],
      subject: null,
      predicate: null,
      object: null,
      ...overrides,
    },
    embedding: CANDIDATE_EMBEDDING,
  };
}

function makeMemoryInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'User works at Acme Corp',
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
    ...overrides,
  };
}

describe('reconcile → persist over real D1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ADD: fresh fact lands as a readable, FTS-indexed row with vector + audit', async () => {
    const { service, data, stubs } = makeHarness();

    const candidate = makeEmbeddedCandidate();
    const decisions = await reconcile([candidate], makeReconcileEnv(data));

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('add');
    expect(mockReconcileCandidate).not.toHaveBeenCalled();

    const ids = await persist(decisions, SCOPE, 'chat', data, PRODUCT_ID, 'wf-int-add');
    expect(ids).toHaveLength(1);

    // Row is readable from real D1 with the candidate's fields intact.
    const row = await service.memoryGetById(PRODUCT_ID, ids[0]);
    expect(row).not.toBeNull();
    expect(row!.content).toBe('User prefers TypeScript for backend work');
    expect(row!.status).toBe('active');
    expect(row!.user_id).toBe('user-a');
    expect(row!.agent_id).toBeNull();
    expect(row!.source_channel).toBe('chat');

    // The FTS insert trigger indexed the row (real memories_fts + triggers).
    const found = await service.memorySearch(PRODUCT_ID, 'TypeScript', { user_id: 'user-a' }, 10);
    expect(found.map((m) => m.id)).toContain(ids[0]);

    // Vector upsert captured with scope-correct metadata (no null scope keys).
    expect(stubs.vectorUpsertMany).toHaveBeenCalledOnce();
    const [upsertProduct, upsertItems] = stubs.vectorUpsertMany.mock.calls[0];
    expect(upsertProduct).toBe(PRODUCT_ID);
    expect(upsertItems).toHaveLength(1);
    expect(upsertItems[0].memoryId).toBe(ids[0]);
    expect(upsertItems[0].embedding).toEqual(CANDIDATE_EMBEDDING);
    expect(upsertItems[0].metadata).toEqual({
      type: 'fact',
      status: 'active',
      source_type: 'user_stated',
      confidence: 0.9,
      user_id: 'user-a',
    });
    expect(stubs.vectorDeleteMany).not.toHaveBeenCalled();

    // Audit row persisted in real D1.
    const audits = await service.auditGetByMemoryId(PRODUCT_ID, ids[0]);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('created');
    expect(audits[0].triggered_by).toBe('ingestion_pipeline');
  });

  it('SUPERSEDE: contradicting fact creates B, marks A superseded_by=B over real FK', async () => {
    const { service, data, stubs } = makeHarness();

    // Seed the existing (soon-to-be-contradicted) memory A through the real repo.
    const memoryA = await service.memoryCreate(PRODUCT_ID, makeMemoryInput());

    // Vector arm surfaces A at moderate similarity (LLM territory: 0.6–0.95).
    stubs.vectorSearch.mockResolvedValue([{ memory_id: memoryA.id, score: 0.8 }]);
    // The D1 recent-memory arm re-embeds A; make it orthogonal so the vector
    // arm's 0.8 stays the best score.
    stubs.generateEmbeddings.mockImplementation(async (texts: string[]) =>
      texts.map(() => ORTHOGONAL_EMBEDDING),
    );

    mockReconcileCandidate.mockResolvedValueOnce({
      action: 'supersede',
      reason: 'User changed employers',
      existing_memory_id: memoryA.id,
      merged_content: null,
    });

    const candidate = makeEmbeddedCandidate({ content: 'User works at Globex now' });
    const decisions = await reconcile([candidate], makeReconcileEnv(data));

    // The LLM arm saw the REAL D1 record for A (ghost-vector verification).
    expect(mockReconcileCandidate).toHaveBeenCalledOnce();
    const similarArg = mockReconcileCandidate.mock.calls[0][1];
    expect(similarArg).toHaveLength(1);
    expect(similarArg[0].memory.id).toBe(memoryA.id);
    expect(similarArg[0].score).toBe(0.8);

    expect(decisions[0].action).toBe('supersede');
    expect(decisions[0].existing_memory_id).toBe(memoryA.id);

    const ids = await persist(decisions, SCOPE, 'chat', data, PRODUCT_ID, 'wf-int-supersede');
    expect(ids).toHaveLength(1);
    const newId = ids[0];
    expect(newId).not.toBe(memoryA.id);

    // New memory B exists and is active.
    const memoryB = await service.memoryGetById(PRODUCT_ID, newId);
    expect(memoryB).not.toBeNull();
    expect(memoryB!.status).toBe('active');
    expect(memoryB!.content).toBe('User works at Globex now');

    // A is superseded AND points at B — the FK (superseded_by REFERENCES
    // memories.id) held because persist created B before updating A.
    const memoryAAfter = await service.memoryGetById(PRODUCT_ID, memoryA.id);
    expect(memoryAAfter!.status).toBe('superseded');
    expect(memoryAAfter!.superseded_by).toBe(newId);

    // Audit chain: A got a 'superseded' entry, B got a 'created' entry.
    const auditsA = await service.auditGetByMemoryId(PRODUCT_ID, memoryA.id);
    expect(auditsA.map((a) => a.action)).toContain('superseded');
    const supersededAudit = auditsA.find((a) => a.action === 'superseded')!;
    expect(supersededAudit.reason).toBe('User changed employers');
    expect(supersededAudit.triggered_by).toBe('ingestion_pipeline');

    const auditsB = await service.auditGetByMemoryId(PRODUCT_ID, newId);
    expect(auditsB).toHaveLength(1);
    expect(auditsB[0].action).toBe('created');
    expect(auditsB[0].reason).toBe(`Superseded memory ${memoryA.id}`);

    // Vector ops: persist deletes A's vector and upserts B's.
    expect(stubs.vectorDeleteMany).toHaveBeenCalledOnce();
    expect(stubs.vectorDeleteMany).toHaveBeenCalledWith(PRODUCT_ID, [memoryA.id]);
    expect(stubs.vectorUpsertMany).toHaveBeenCalledOnce();
    expect(stubs.vectorUpsertMany.mock.calls[0][1][0].memoryId).toBe(newId);

    // Superseded memories drop out of FTS-backed search (status filter),
    // while the replacement is findable.
    const staleHits = await service.memorySearch(PRODUCT_ID, 'Acme', { user_id: 'user-a' }, 10);
    expect(staleHits.map((m) => m.id)).not.toContain(memoryA.id);
    const freshHits = await service.memorySearch(PRODUCT_ID, 'Globex', { user_id: 'user-a' }, 10);
    expect(freshHits.map((m) => m.id)).toContain(newId);
  });

  it('retry convergence: running persist twice with the same instanceId creates no duplicates', async () => {
    const { service, data } = makeHarness();

    const memoryA = await service.memoryCreate(PRODUCT_ID, makeMemoryInput());

    const decisions: ReconcileDecision[] = [
      {
        action: 'add',
        candidate: makeEmbeddedCandidate({ content: 'User plays the saxophone' }),
        reason: 'New fact',
      },
      {
        action: 'supersede',
        candidate: makeEmbeddedCandidate({ content: 'User works at Globex now' }),
        existing_memory_id: memoryA.id,
        reason: 'Updated employer',
      },
    ];

    const first = await persist(decisions, SCOPE, 'chat', data, PRODUCT_ID, 'wf-int-retry');
    // Simulated Workflow step retry: same decisions, same instanceId.
    const second = await persist(decisions, SCOPE, 'chat', data, PRODUCT_ID, 'wf-int-retry');

    // Deterministic ids: the retry converges on the same records.
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(2);

    // Exact survivor set over real D1: A + the two new memories, nothing else.
    const all = await service.memoryListByScope(PRODUCT_ID, { user_id: 'user-a' }, { limit: 50 });
    expect(all.items.map((m) => m.id).sort()).toEqual([...first, memoryA.id].sort());

    // Final state is stable: A superseded by the same deterministic id.
    const memoryAAfter = await service.memoryGetById(PRODUCT_ID, memoryA.id);
    expect(memoryAAfter!.status).toBe('superseded');
    expect(memoryAAfter!.superseded_by).toBe(second[1]);

    // The created-audit is gated on first creation — exactly one per new row.
    for (const id of first) {
      const audits = await service.auditGetByMemoryId(PRODUCT_ID, id);
      expect(audits.filter((a) => a.action === 'created')).toHaveLength(1);
    }

    // Current behavior: the supersede audit is NOT gated on first creation,
    // so a retried step logs it again (append-only audit; acceptable, but
    // pinned here so a change is deliberate).
    const auditsA = await service.auditGetByMemoryId(PRODUCT_ID, memoryA.id);
    expect(auditsA.filter((a) => a.action === 'superseded')).toHaveLength(2);
  });

  it('auto-SKIP: near-verbatim duplicate (cosine ≥ 0.95 via the D1 recent arm) persists nothing', async () => {
    const { service, data, stubs } = makeHarness();

    const existing = await service.memoryCreate(
      PRODUCT_ID,
      makeMemoryInput({ content: 'User prefers TypeScript for backend work' }),
    );

    // Vectorize hasn't indexed the seed yet (bulk-import lag) — the D1
    // recent-memory arm must catch the duplicate. Identical embedding
    // yields cosine 1.0 ≥ the 0.95 auto-skip threshold.
    stubs.vectorSearch.mockResolvedValue([]);
    stubs.generateEmbeddings.mockImplementation(async (texts: string[]) =>
      texts.map(() => CANDIDATE_EMBEDDING),
    );

    const decisions = await reconcile([makeEmbeddedCandidate()], makeReconcileEnv(data));

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('skip');
    expect(decisions[0].existing_memory_id).toBe(existing.id);
    expect(decisions[0].reason).toContain('Auto-skipped');
    expect(mockReconcileCandidate).not.toHaveBeenCalled();

    // SKIP decisions persist nothing: no new rows, no vector ops, no audits.
    const ids = await persist(decisions, SCOPE, 'chat', data, PRODUCT_ID, 'wf-int-skip');
    expect(ids).toEqual([]);

    const all = await service.memoryListByScope(PRODUCT_ID, { user_id: 'user-a' }, { limit: 50 });
    expect(all.items.map((m) => m.id)).toEqual([existing.id]);
    expect(stubs.vectorUpsertMany).not.toHaveBeenCalled();
    expect(stubs.vectorDeleteMany).not.toHaveBeenCalled();
    const audits = await service.auditGetByMemoryId(PRODUCT_ID, existing.id);
    expect(audits).toEqual([]);
  });
});
