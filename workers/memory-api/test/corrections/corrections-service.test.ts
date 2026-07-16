import { describe, it, expect } from 'vitest';
import type { CorrectionRequest, Memory } from '@deeprecall/types';
import {
  applyCorrection,
  type CorrectionsContext,
} from '../../src/corrections/corrections-service';
import { CorrectionRequestError } from '../../src/corrections/errors';

// ─── Fakes ───────────────────────────────────────────────────

interface Call {
  method: string;
  args: unknown[];
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    content: 'User lives in Tel Aviv',
    episode: 'ep-1',
    type: 'fact',
    status: 'active',
    user_id: 'u1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'inferred',
    source_channel: 'chat',
    confidence: 0.7,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    superseded_by: null,
    tags: ['location'],
    subject: 'user',
    predicate: 'lives_in',
    object: 'Tel Aviv',
    ...overrides,
  } as Memory;
}

function fakeData(opts: { memory?: Memory | null; embedFails?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async memoryGetById() {
      calls.push({ method: 'memoryGetById', args: [] });
      return opts.memory === undefined ? memory() : opts.memory;
    },
    async memoryUpdateStatus(_p: string, id: string, status: string, supersededBy?: string) {
      calls.push({ method: 'memoryUpdateStatus', args: [id, status, supersededBy] });
    },
    async memoryUpdateConfidenceAndSourceType(
      _p: string,
      id: string,
      confidence: number,
      sourceType: string,
    ) {
      calls.push({
        method: 'memoryUpdateConfidenceAndSourceType',
        args: [id, confidence, sourceType],
      });
    },
    async memoryCreate(_p: string, input: Record<string, unknown>) {
      calls.push({ method: 'memoryCreate', args: [input] });
      return { ...memory(), ...input } as Memory;
    },
    async vectorDelete(_p: string, id: string) {
      calls.push({ method: 'vectorDelete', args: [id] });
    },
    async vectorUpsert(_p: string, id: string, embedding: number[], metadata: unknown) {
      calls.push({ method: 'vectorUpsert', args: [id, embedding, metadata] });
    },
    async auditLog(
      _p: string,
      action: string,
      memoryId: string,
      reason: string,
      oldValue: unknown,
      newValue: unknown,
      triggeredBy: string,
    ) {
      calls.push({
        method: 'auditLog',
        args: [action, memoryId, reason, oldValue, newValue, triggeredBy],
      });
    },
    async generateEmbeddings(texts: string[]) {
      calls.push({ method: 'generateEmbeddings', args: [texts] });
      return opts.embedFails ? [] : [[0.1, 0.2, 0.3]];
    },
  };
}

function ctxWith(data: object): CorrectionsContext {
  return { env: { DATA: data } as unknown as Env, productId: 'p1' };
}

function request(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    memory_id: 'mem-1',
    action: 'suppress',
    scope: { user_id: 'u1' },
    ...overrides,
  } as CorrectionRequest;
}

// ─── Tests ───────────────────────────────────────────────────

describe('applyCorrection guards', () => {
  it('throws NOT_FOUND (404) when the memory does not exist', async () => {
    const err = await applyCorrection(request(), ctxWith(fakeData({ memory: null }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CorrectionRequestError);
    expect((err as CorrectionRequestError).status).toBe(404);
    expect((err as CorrectionRequestError).code).toBe('NOT_FOUND');
    expect((err as CorrectionRequestError).message).toBe('Memory mem-1 not found');
  });

  it('throws AUTHENTICATION_ERROR (403) when the scope does not match', async () => {
    const err = await applyCorrection(
      request({ scope: { user_id: 'someone-else' } }),
      ctxWith(fakeData()),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorrectionRequestError);
    expect((err as CorrectionRequestError).status).toBe(403);
    expect((err as CorrectionRequestError).code).toBe('AUTHENTICATION_ERROR');
    expect((err as CorrectionRequestError).message).toBe(
      'Memory does not belong to the specified scope',
    );
  });
});

describe.each([
  ['suppress', 'suppressed', 'suppressed', 'User-initiated suppression'],
  ['expire', 'expired', 'expired', 'User-initiated expiry'],
  ['delete', 'archived', 'deleted', 'User-initiated deletion'],
] as const)('applyCorrection %s', (action, newStatus, auditAction, defaultReason) => {
  it(`sets status ${newStatus}, drops the vector, audits ${auditAction}`, async () => {
    const data = fakeData();
    const result = await applyCorrection(request({ action }), ctxWith(data));

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual(['memoryGetById', 'memoryUpdateStatus', 'vectorDelete', 'auditLog']);

    const statusCall = data.calls.find((c) => c.method === 'memoryUpdateStatus')!;
    expect(statusCall.args).toEqual(['mem-1', newStatus, undefined]);

    const audit = data.calls.find((c) => c.method === 'auditLog')!;
    expect(audit.args[0]).toBe(auditAction);
    expect(audit.args[1]).toBe('mem-1');
    expect(audit.args[2]).toBe(defaultReason);
    expect(audit.args[4]).toBeNull(); // no new value
    expect(audit.args[5]).toBe('user_correction');

    expect(result).toEqual({
      action,
      memory_id: 'mem-1',
      new_memory_id: null,
      message: `Memory mem-1 ${auditAction} successfully`,
    });
  });

  it('uses the caller-provided reason when present', async () => {
    const data = fakeData();
    await applyCorrection(request({ action, reason: 'my reason' }), ctxWith(data));
    const audit = data.calls.find((c) => c.method === 'auditLog')!;
    expect(audit.args[2]).toBe('my reason');
  });
});

describe('applyCorrection pin', () => {
  it('sets confidence 1.0 + user_stated, audits, and refreshes the vector', async () => {
    const data = fakeData();
    const result = await applyCorrection(request({ action: 'pin' }), ctxWith(data));

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'memoryGetById',
      'memoryUpdateConfidenceAndSourceType',
      'auditLog',
      'generateEmbeddings',
      'vectorUpsert',
    ]);

    const confCall = data.calls.find((c) => c.method === 'memoryUpdateConfidenceAndSourceType')!;
    expect(confCall.args).toEqual(['mem-1', 1.0, 'user_stated']);

    // Vector metadata: keeps the memory's CURRENT status, scope keys only
    // when present (no nulls in Vectorize metadata).
    const upsert = data.calls.find((c) => c.method === 'vectorUpsert')!;
    expect(upsert.args[0]).toBe('mem-1');
    expect(upsert.args[2]).toEqual({
      user_id: 'u1',
      type: 'fact',
      status: 'active',
      source_type: 'user_stated',
      confidence: 1.0,
    });

    expect(result.new_memory_id).toBeNull();
    expect(result.message).toBe('Memory mem-1 pinned successfully');
  });

  it('keeps the D1 pin even when embedding fails (vector refresh is best-effort)', async () => {
    const data = fakeData({ embedFails: true });
    const result = await applyCorrection(request({ action: 'pin' }), ctxWith(data));
    const methods = data.calls.map((c) => c.method);
    expect(methods).toContain('memoryUpdateConfidenceAndSourceType');
    expect(methods).not.toContain('vectorUpsert');
    expect(result.message).toBe('Memory mem-1 pinned successfully');
  });
});

describe('applyCorrection update', () => {
  it('creates the new memory BEFORE superseding the old (FK invariant)', async () => {
    const data = fakeData();
    const result = await applyCorrection(
      request({ action: 'update', updated_content: 'User lives in Haifa' }),
      ctxWith(data),
    );

    const methods = data.calls.map((c) => c.method);
    expect(methods).toEqual([
      'memoryGetById',
      'generateEmbeddings',
      'memoryCreate', // new row first...
      'memoryUpdateStatus', // ...then supersede pointing at it
      'vectorDelete',
      'vectorUpsert',
      'auditLog', // superseded (old)
      'auditLog', // corrected (new)
    ]);

    const created = data.calls.find((c) => c.method === 'memoryCreate')!.args[0] as Record<
      string,
      unknown
    >;
    expect(created).toMatchObject({
      content: 'User lives in Haifa',
      status: 'active',
      source_type: 'user_stated',
      confidence: 1.0,
      user_id: 'u1',
      type: 'fact',
    });
    const newId = created.id as string;

    const statusCall = data.calls.find((c) => c.method === 'memoryUpdateStatus')!;
    expect(statusCall.args).toEqual(['mem-1', 'superseded', newId]);

    // Old vector dropped, new vector written as active user_stated.
    expect(data.calls.find((c) => c.method === 'vectorDelete')!.args[0]).toBe('mem-1');
    const upsert = data.calls.find((c) => c.method === 'vectorUpsert')!;
    expect(upsert.args[0]).toBe(newId);
    expect(upsert.args[2]).toEqual({
      user_id: 'u1',
      type: 'fact',
      status: 'active',
      source_type: 'user_stated',
      confidence: 1.0,
    });

    // Audit pair: supersede old, then corrected new.
    const audits = data.calls.filter((c) => c.method === 'auditLog');
    expect(audits[0]!.args[0]).toBe('superseded');
    expect(audits[0]!.args[1]).toBe('mem-1');
    expect(audits[0]!.args[2]).toBe('Superseded by user correction');
    expect(audits[1]!.args[0]).toBe('corrected');
    expect(audits[1]!.args[1]).toBe(newId);
    expect(audits[1]!.args[2]).toBe('Corrected version of memory mem-1');

    expect(result).toEqual({
      action: 'update',
      memory_id: 'mem-1',
      new_memory_id: newId,
      message: 'Memory mem-1 updated successfully',
    });
  });

  it('throws INTERNAL_ERROR (500) and mutates nothing when embedding fails', async () => {
    const data = fakeData({ embedFails: true });
    const err = await applyCorrection(
      request({ action: 'update', updated_content: 'new content' }),
      ctxWith(data),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CorrectionRequestError);
    expect((err as CorrectionRequestError).status).toBe(500);
    expect((err as CorrectionRequestError).code).toBe('INTERNAL_ERROR');
    expect((err as CorrectionRequestError).message).toBe(
      'Failed to generate embedding for updated content',
    );
    // Nothing was created or superseded.
    const methods = data.calls.map((c) => c.method);
    expect(methods).not.toContain('memoryCreate');
    expect(methods).not.toContain('memoryUpdateStatus');
  });
});
