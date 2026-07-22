import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory, MemoryCandidate as MemoryCandidateType } from '@deeprecall/types';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: (config: unknown) => config,
  },
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { reconcileCandidate } from '../reconciliation';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../claude';
import type {
  SimilarMemory,
  ReconciliationConfig,
  ReconciliationDecision,
} from '../reconciliation';

const mockGenerateText = vi.mocked(generateText);
const mockCreateAnthropic = vi.mocked(createAnthropic);

const config: ReconciliationConfig = {
  claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
};

const candidate: MemoryCandidateType = {
  content: 'User works at Acme Corp',
  episode: null,
  type: 'fact',
  source_actor: 'user',
  source_type: 'user_stated',
  confidence: 0.9,
  validity_start: null,
  validity_end: null,
  tags: ['work'],
  subject: 'user',
  predicate: 'works_at',
  object: 'Acme Corp',
};

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'existing-1',
    content: 'User works at BigCo',
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

describe('reconcileCandidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropic.mockReturnValue(
      vi.fn(() => 'mock-model') as ReturnType<typeof createAnthropic>,
    );
  });

  it('returns ADD without LLM call when no similar memories', async () => {
    const result = await reconcileCandidate(candidate, [], config);

    expect(result.action).toBe('add');
    expect(result.reason).toBe('No similar existing memories found');
    expect(result.existing_memory_id).toBeNull();
    expect(result.merged_content).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('passes the Claude output-token ceiling so adaptive thinking cannot starve structured output', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        action: 'skip',
        reason: 'duplicate',
        existing_memory_id: null,
        merged_content: null,
      },
    } as never);

    await reconcileCandidate(candidate, [{ memory: makeMemory(), score: 0.85 }], config);

    expect(mockGenerateText.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    });
  });

  it('calls LLM when similar memories exist', async () => {
    const decision: ReconciliationDecision = {
      action: 'supersede',
      reason: 'User changed employers',
      existing_memory_id: 'existing-1',
      merged_content: null,
    };
    mockGenerateText.mockResolvedValueOnce({
      output: decision,
    } as never);

    const similar: SimilarMemory[] = [{ memory: makeMemory(), score: 0.85 }];

    const result = await reconcileCandidate(candidate, similar, config);

    expect(result.action).toBe('supersede');
    expect(result.existing_memory_id).toBe('existing-1');
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it('includes candidate and existing memory data in prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        action: 'add',
        reason: 'Different topics',
        existing_memory_id: null,
        merged_content: null,
      },
    } as never);

    const similar: SimilarMemory[] = [
      { memory: makeMemory({ id: 'mem-99', content: 'User likes coffee' }), score: 0.6 },
    ];

    await reconcileCandidate(candidate, similar, config);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('User works at Acme Corp');
    expect(call.prompt).toContain('User likes coffee');
    expect(call.prompt).toContain('mem-99');
  });

  it('handles MERGE decision with merged content', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        action: 'merge',
        reason: 'Same topic, complementary info',
        existing_memory_id: 'existing-1',
        merged_content: 'User works at Acme Corp as a senior engineer',
      },
    } as never);

    const similar: SimilarMemory[] = [{ memory: makeMemory(), score: 0.9 }];

    const result = await reconcileCandidate(candidate, similar, config);

    expect(result.action).toBe('merge');
    expect(result.merged_content).toBe('User works at Acme Corp as a senior engineer');
  });

  it('handles SKIP decision', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        action: 'skip',
        reason: 'Duplicate information',
        existing_memory_id: null,
        merged_content: null,
      },
    } as never);

    const similar: SimilarMemory[] = [
      { memory: makeMemory({ content: 'User works at Acme Corp' }), score: 0.98 },
    ];

    const result = await reconcileCandidate(candidate, similar, config);

    expect(result.action).toBe('skip');
  });

  it('uses custom model when specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({
      output: {
        action: 'add',
        reason: 'New',
        existing_memory_id: null,
        merged_content: null,
      },
    } as never);

    await reconcileCandidate(candidate, [{ memory: makeMemory(), score: 0.5 }], {
      ...config,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(modelFn).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it('propagates API errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      reconcileCandidate(candidate, [{ memory: makeMemory(), score: 0.7 }], config),
    ).rejects.toThrow('Network error');
  });
});
