import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';
import { adjudicateConflict } from '@deeprecall/ai';
import { runConflictResolution } from '../../src/jobs/conflict-resolution';

vi.mock('@deeprecall/ai', () => ({
  adjudicateConflict: vi.fn(),
}));

const mockAdjudicate = vi.mocked(adjudicateConflict);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'Test fact',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'agent_inferred',
    source_channel: 'chat',
    confidence: 0.8,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: '2025-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    superseded_by: null,
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

/**
 * Mock data service backed by a memory map, so memoryGetByIds stays correct
 * regardless of how many times the job calls it.
 */
function makeMockData(memories: Memory[]) {
  const byId = new Map(memories.map((m) => [m.id, m]));
  return {
    memoryGetByIds: vi
      .fn()
      .mockImplementation(async (_productId: string, ids: string[]) =>
        ids.map((id) => byId.get(id)).filter(Boolean),
      ),
    memoryCreate: vi.fn().mockImplementation(async (_productId: string, input: any) => {
      const created = makeMemory({ ...input });
      byId.set(created.id, created);
      return created;
    }),
    generateEmbeddings: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    vectorSearch: vi.fn().mockResolvedValue([]),
    vectorUpsert: vi.fn().mockResolvedValue(undefined),
    memoryUpdateStatus: vi
      .fn()
      .mockImplementation(async (_productId: string, id: string, status: string) => {
        const mem = byId.get(id);
        if (mem) byId.set(id, { ...mem, status: status as Memory['status'] });
      }),
    vectorDelete: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const API_KEY = { provider: 'anthropic' as const, apiKey: 'test-key' };

describe('runConflictResolution', () => {
  beforeEach(() => {
    mockAdjudicate.mockReset();
  });

  it('returns zero counts when no similar memories', async () => {
    const newMem = makeMemory();
    const data = makeMockData([newMem]);

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(0);
    expect(result.resolved_count).toBe(0);
    expect(mockAdjudicate).not.toHaveBeenCalled();
  });

  it('keeps both memories when the LLM says they are distinct', async () => {
    const newMem = makeMemory({ content: 'Camping trip in the mountains in June' });
    const oldMem = makeMemory({ content: 'Camping trip in the forest in July' });
    const data = makeMockData([newMem, oldMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: oldMem.id, score: 0.9 }]);
    mockAdjudicate.mockResolvedValue({
      relation: 'distinct',
      action: 'keep_both',
      merged_content: null,
      reason: 'Different trips',
    });

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(1);
    expect(result.resolved_count).toBe(0);
    expect(data.memoryUpdateStatus).not.toHaveBeenCalled();
    expect(data.vectorDelete).not.toHaveBeenCalled();
  });

  it('supersedes the older memory when the LLM says it is redundant', async () => {
    const newMem = makeMemory({ content: 'Has a dog named Oliver and cats Luna and Bailey' });
    const oldMem = makeMemory({ content: 'Has pets' });
    const data = makeMockData([newMem, oldMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: oldMem.id, score: 0.9 }]);
    mockAdjudicate.mockResolvedValue({
      relation: 'duplicate',
      action: 'supersede_b',
      merged_content: null,
      reason: 'Newer memory fully covers the older',
    });

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.resolved_count).toBe(1);
    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      'default',
      oldMem.id,
      'superseded',
      newMem.id,
    );
    expect(data.vectorDelete).toHaveBeenCalledWith('default', oldMem.id);
    expect(data.auditLog).toHaveBeenCalledWith(
      'default',
      'superseded',
      oldMem.id,
      expect.stringContaining('LLM-adjudicated'),
      oldMem,
      null,
      'consolidation',
    );
  });

  it('can supersede the newer memory when the older one is more complete', async () => {
    const newMem = makeMemory({ content: 'Has kids' });
    const oldMem = makeMemory({ content: 'Has three kids, two of them younger' });
    const data = makeMockData([newMem, oldMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: oldMem.id, score: 0.9 }]);
    mockAdjudicate.mockResolvedValue({
      relation: 'duplicate',
      action: 'supersede_a',
      merged_content: null,
      reason: 'Older memory is more specific',
    });

    await runConflictResolution({ user_id: 'user-1' }, [newMem.id], data, 'default', API_KEY);

    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      'default',
      newMem.id,
      'superseded',
      oldMem.id,
    );
  });

  it('merges a contradiction into a single richer memory', async () => {
    const newMem = makeMemory({
      content: 'Pets: dog Oliver, cat Bailey',
      tags: ['pets'],
    });
    const oldMem = makeMemory({
      content: 'Pets: dog and cat named Luna and Oliver',
      tags: ['animals'],
    });
    const data = makeMockData([newMem, oldMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: oldMem.id, score: 0.9 }]);
    mockAdjudicate.mockResolvedValue({
      relation: 'contradiction',
      action: 'merge',
      merged_content: 'Pets: dog Oliver, cats Luna and Bailey',
      reason: 'Complete pet list',
    });

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.resolved_count).toBe(1);
    expect(data.memoryCreate).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        content: 'Pets: dog Oliver, cats Luna and Bailey',
        tags: expect.arrayContaining(['pets', 'animals']),
      }),
    );
    const mergedId = data.memoryCreate.mock.calls[0][1].id;
    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      'default',
      newMem.id,
      'superseded',
      mergedId,
    );
    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      'default',
      oldMem.id,
      'superseded',
      mergedId,
    );
    expect(data.vectorUpsert).toHaveBeenCalledWith(
      'default',
      mergedId,
      expect.anything(),
      expect.objectContaining({ user_id: 'user-1', status: 'active' }),
    );
  });

  it('keeps both when adjudication fails, never falling back to rules', async () => {
    const newMem = makeMemory();
    const oldMem = makeMemory();
    const data = makeMockData([newMem, oldMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: oldMem.id, score: 0.9 }]);
    mockAdjudicate.mockRejectedValue(new Error('LLM unavailable'));

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(1);
    expect(result.resolved_count).toBe(0);
    expect(data.memoryUpdateStatus).not.toHaveBeenCalled();
  });

  it('skips pinned memories (user_stated with confidence >= 1.0)', async () => {
    const newMem = makeMemory({ confidence: 0.9 });
    const pinnedMem = makeMemory({
      source_type: 'user_stated',
      confidence: 1.0,
    });
    const data = makeMockData([newMem, pinnedMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: pinnedMem.id, score: 0.9 }]);

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(0);
    expect(mockAdjudicate).not.toHaveBeenCalled();
    expect(data.memoryUpdateStatus).not.toHaveBeenCalled();
  });

  it('skips conflicts below similarity threshold (0.85)', async () => {
    const newMem = makeMemory();
    const data = makeMockData([newMem]);
    data.vectorSearch.mockResolvedValue([{ memory_id: 'other-id', score: 0.8 }]);

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(0);
    expect(mockAdjudicate).not.toHaveBeenCalled();
  });

  it('skips conflicts that are newly ingested (same batch)', async () => {
    const newMem1 = makeMemory();
    const newMem2 = makeMemory();
    const data = makeMockData([newMem1, newMem2]);
    data.vectorSearch.mockResolvedValue([{ memory_id: newMem2.id, score: 0.9 }]);

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [newMem1.id, newMem2.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(0);
    expect(data.memoryUpdateStatus).not.toHaveBeenCalled();
  });

  it('filters out non-active new memories', async () => {
    const superseded = makeMemory({ status: 'superseded' });
    const data = makeMockData([superseded]);

    const result = await runConflictResolution(
      { user_id: 'user-1' },
      [superseded.id],
      data,
      'default',
      API_KEY,
    );

    expect(result.conflicts_found).toBe(0);
    expect(data.vectorSearch).not.toHaveBeenCalled();
  });

  it('does not reprocess a memory retired earlier in the same run', async () => {
    const mem1 = makeMemory({ content: 'Fact v1' });
    const mem2 = makeMemory({ content: 'Fact v2' });
    const oldMem = makeMemory({ content: 'Fact v0' });
    const data = makeMockData([mem1, mem2, oldMem]);
    // mem1 finds oldMem; adjudication supersedes mem1 itself. mem2 finds
    // nothing. When the loop reaches a memory that was retired, it skips.
    data.vectorSearch
      .mockResolvedValueOnce([{ memory_id: oldMem.id, score: 0.9 }])
      .mockResolvedValue([]);
    mockAdjudicate.mockResolvedValue({
      relation: 'duplicate',
      action: 'supersede_a',
      merged_content: null,
      reason: 'Older memory covers it',
    });

    await runConflictResolution(
      { user_id: 'user-1' },
      [mem1.id, mem2.id],
      data,
      'default',
      API_KEY,
    );

    // mem1 was superseded; only one supersede happened in total
    expect(data.memoryUpdateStatus).toHaveBeenCalledTimes(1);
  });
});
