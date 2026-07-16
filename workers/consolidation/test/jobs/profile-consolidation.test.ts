import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';

// Mock @deeprecall/ai before importing
vi.mock('@deeprecall/ai', () => ({
  consolidateProfile: vi.fn(),
}));

import { consolidateProfile } from '@deeprecall/ai';
import { runProfileConsolidation } from '../../src/jobs/profile-consolidation';

const mockConsolidateProfile = vi.mocked(consolidateProfile);

function makeFact(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'User likes TypeScript',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
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

function makeMockData() {
  return {
    memoryFindFactsForProfile: vi.fn().mockResolvedValue([]),
    generateEmbeddings: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    memoryListByScope: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    memoryCreate: vi
      .fn()
      .mockImplementation((_, input) => Promise.resolve({ ...makeFact(), ...input })),
    vectorUpsert: vi.fn().mockResolvedValue(undefined),
    memoryUpdateStatus: vi.fn().mockResolvedValue(undefined),
    vectorDelete: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const CLAUDE = { provider: 'anthropic' as const, apiKey: 'test-key' };

describe('runProfileConsolidation', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    vi.clearAllMocks();
    data = makeMockData();
  });

  it('returns early when fewer than 3 facts', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact()]);

    const result = await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    expect(result.profile_created).toBe(false);
    expect(result.facts_consolidated).toBe(0);
    expect(result.profile_memory_id).toBeNull();
    expect(mockConsolidateProfile).not.toHaveBeenCalled();
  });

  it('creates profile when 3+ facts available', async () => {
    const facts = [makeFact(), makeFact(), makeFact()];
    data.memoryFindFactsForProfile.mockResolvedValue(facts);
    mockConsolidateProfile.mockResolvedValue(
      'The user is a TypeScript developer who enjoys coding.',
    );

    const result = await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    expect(result.profile_created).toBe(true);
    expect(result.facts_consolidated).toBe(3);
    expect(result.profile_memory_id).toBeTruthy();
    expect(data.memoryCreate).toHaveBeenCalledOnce();
    expect(data.vectorUpsert).toHaveBeenCalledOnce();
  });

  it('creates profile with correct attributes', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact(), makeFact()]);
    mockConsolidateProfile.mockResolvedValue('Profile summary');

    await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    const createCall = data.memoryCreate.mock.calls[0][1];
    expect(createCall.type).toBe('profile');
    expect(createCall.status).toBe('active');
    expect(createCall.confidence).toBe(1.0);
    expect(createCall.source_type).toBe('system_imported');
    expect(createCall.source_actor).toBe('system');
    expect(createCall.user_id).toBe('user-1');
    expect(createCall.tags).toEqual(['auto_profile']);
    expect(createCall.content).toBe('Profile summary');
  });

  it('supersedes existing profiles', async () => {
    const oldProfile = makeFact({ type: 'profile', id: 'old-profile-1' });
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact(), makeFact()]);
    data.memoryListByScope.mockResolvedValue({
      items: [oldProfile],
      cursor: null,
    });
    mockConsolidateProfile.mockResolvedValue('New profile');

    const result = await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    expect(data.memoryUpdateStatus).toHaveBeenCalledWith(
      'default',
      'old-profile-1',
      'superseded',
      result.profile_memory_id,
    );
    expect(data.vectorDelete).toHaveBeenCalledWith('default', 'old-profile-1');
  });

  it('logs audit for both new profile and superseded old ones', async () => {
    const oldProfile = makeFact({ type: 'profile' });
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact(), makeFact()]);
    data.memoryListByScope.mockResolvedValue({
      items: [oldProfile],
      cursor: null,
    });
    mockConsolidateProfile.mockResolvedValue('Profile');

    await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    // Two audit entries: supersede old + create new
    expect(data.auditLog).toHaveBeenCalledTimes(2);
    expect(data.auditLog).toHaveBeenCalledWith(
      'default',
      'superseded',
      oldProfile.id,
      expect.stringContaining('Superseded by new consolidated profile'),
      oldProfile,
      null,
      'consolidation',
    );
    expect(data.auditLog).toHaveBeenCalledWith(
      'default',
      'created',
      expect.any(String),
      expect.stringContaining('3 facts'),
      null,
      expect.any(Object),
      'consolidation',
    );
  });

  it('throws when embedding generation fails', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact(), makeFact()]);
    data.generateEmbeddings.mockResolvedValue([]);
    mockConsolidateProfile.mockResolvedValue('Profile');

    await expect(
      runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE),
    ).rejects.toThrow('Failed to generate embedding');
  });

  it('agent-only scope: profile carries agent_id, user_id stays null', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([
      makeFact({ user_id: null, agent_id: 'agent-1' }),
      makeFact({ user_id: null, agent_id: 'agent-1' }),
      makeFact({ user_id: null, agent_id: 'agent-1' }),
    ]);
    mockConsolidateProfile.mockResolvedValue('Agent profile');

    await runProfileConsolidation({ agent_id: 'agent-1' }, 'default', data, CLAUDE);

    const createCall = data.memoryCreate.mock.calls[0][1];
    expect(createCall.user_id).toBeNull();
    expect(createCall.agent_id).toBe('agent-1');
    expect(createCall.type).toBe('profile');

    // Vectorize metadata must NOT write null user_id.
    const vectorMetadata = data.vectorUpsert.mock.calls[0][3] as Record<string, unknown>;
    expect('user_id' in vectorMetadata).toBe(false);
    expect(vectorMetadata.agent_id).toBe('agent-1');
  });

  it('both scope: user run propagates user_id only onto the profile', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([
      makeFact({ user_id: 'user-B', agent_id: 'agent-B' }),
      makeFact({ user_id: 'user-B', agent_id: null }),
      makeFact({ user_id: 'user-B', agent_id: null }),
    ]);
    mockConsolidateProfile.mockResolvedValue('User profile');

    // When both keys set, consolidation treats this as a user run.
    await runProfileConsolidation(
      { user_id: 'user-B', agent_id: 'agent-B' },
      'default',
      data,
      CLAUDE,
    );

    const createCall = data.memoryCreate.mock.calls[0][1];
    expect(createCall.user_id).toBe('user-B');
    expect(createCall.agent_id).toBeNull();
  });

  it('throws when scope is empty', async () => {
    await expect(runProfileConsolidation({} as any, 'default', data, CLAUDE)).rejects.toThrow(
      /at least one of user_id or agent_id/,
    );
  });

  it('calls consolidateProfile with correct API key', async () => {
    data.memoryFindFactsForProfile.mockResolvedValue([makeFact(), makeFact(), makeFact()]);
    mockConsolidateProfile.mockResolvedValue('Profile');

    await runProfileConsolidation({ user_id: 'user-1' }, 'default', data, CLAUDE);

    expect(mockConsolidateProfile).toHaveBeenCalledWith(expect.any(Array), { claude: CLAUDE });
  });
});
