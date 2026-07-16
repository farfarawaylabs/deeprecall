import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';
import { runConfidenceDecay } from '../../src/jobs/confidence-decay';

function makeStaleMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'Stale fact',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'agent_inferred',
    source_channel: 'chat',
    confidence: 0.5,
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

function makeMockData() {
  return {
    memoryFindStaleMemories: vi.fn().mockResolvedValue([]),
    memoryUpdateStatus: vi.fn().mockResolvedValue(undefined),
    memoryUpdateConfidence: vi.fn().mockResolvedValue(undefined),
    vectorDelete: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('runConfidenceDecay', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    data = makeMockData();
  });

  it('returns zero counts when no stale memories', async () => {
    const result = await runConfidenceDecay(data, 'default');

    expect(result.decayed_count).toBe(0);
    expect(result.archived_count).toBe(0);
  });

  it('decays confidence by default factor (0.9)', async () => {
    const mem = makeStaleMemory({ confidence: 0.5 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    const result = await runConfidenceDecay(data, 'default');

    expect(result.decayed_count).toBe(1);
    expect(result.archived_count).toBe(0);
    // 0.5 * 0.9 = 0.45
    expect(data.memoryUpdateConfidence).toHaveBeenCalledWith('default', mem.id, 0.45);
  });

  it('uses custom decay factor and stale days', async () => {
    const mem = makeStaleMemory({ confidence: 0.6 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    await runConfidenceDecay(data, 'default', {
      staleDays: 7,
      decayFactor: 0.8,
    });

    // 0.6 * 0.8 = 0.48
    expect(data.memoryUpdateConfidence).toHaveBeenCalledWith('default', mem.id, 0.48);
  });

  it('archives memories below MIN_CONFIDENCE (0.1)', async () => {
    const mem = makeStaleMemory({ confidence: 0.08 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    const result = await runConfidenceDecay(data, 'default');

    expect(result.archived_count).toBe(1);
    expect(result.decayed_count).toBe(0);
    expect(data.memoryUpdateStatus).toHaveBeenCalledWith('default', mem.id, 'archived');
    expect(data.vectorDelete).toHaveBeenCalledWith('default', mem.id);
  });

  it('does not archive memories at exactly 0.1 after decay', async () => {
    // 0.112 * 0.9 = 0.1008 → rounds to 0.101 → above 0.1
    const mem = makeStaleMemory({ confidence: 0.112 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    const result = await runConfidenceDecay(data, 'default');

    expect(result.decayed_count).toBe(1);
    expect(result.archived_count).toBe(0);
  });

  it('archives when decay drops below threshold', async () => {
    // 0.11 * 0.9 = 0.099 → below 0.1
    const mem = makeStaleMemory({ confidence: 0.11 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    const result = await runConfidenceDecay(data, 'default');

    expect(result.archived_count).toBe(1);
  });

  it('logs audit for decayed memories', async () => {
    const mem = makeStaleMemory({ confidence: 0.5 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    await runConfidenceDecay(data, 'default');

    expect(data.auditLog).toHaveBeenCalledWith(
      'default',
      'confidence_updated',
      mem.id,
      expect.stringContaining('0.500'),
      { confidence: 0.5 },
      { confidence: 0.45 },
      'consolidation',
    );
  });

  it('logs audit for archived memories', async () => {
    const mem = makeStaleMemory({ confidence: 0.08 });
    data.memoryFindStaleMemories.mockResolvedValue([mem]);

    await runConfidenceDecay(data, 'default');

    expect(data.auditLog).toHaveBeenCalledWith(
      'default',
      'confidence_updated',
      mem.id,
      expect.stringContaining('archived'),
      expect.objectContaining({ confidence: 0.08 }),
      expect.objectContaining({ status: 'archived' }),
      'consolidation',
    );
  });

  it('processes mixed decayed and archived memories', async () => {
    const highConf = makeStaleMemory({ confidence: 0.5 });
    const lowConf = makeStaleMemory({ confidence: 0.05 });
    data.memoryFindStaleMemories.mockResolvedValue([highConf, lowConf]);

    const result = await runConfidenceDecay(data, 'default');

    expect(result.decayed_count).toBe(1);
    expect(result.archived_count).toBe(1);
  });
});
