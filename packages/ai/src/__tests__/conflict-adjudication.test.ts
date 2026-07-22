import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';

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
import { adjudicateConflict } from '../conflict-adjudication';
import type { ConflictAdjudication, ConflictAdjudicationConfig } from '../conflict-adjudication';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../claude';

const mockGenerateText = vi.mocked(generateText);
const mockCreateAnthropic = vi.mocked(createAnthropic);

const config: ConflictAdjudicationConfig = {
  claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
};

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'User works at Acme Corp',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'chat',
    confidence: 0.9,
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

const sampleDecision: ConflictAdjudication = {
  relation: 'duplicate',
  action: 'supersede_b',
  merged_content: null,
  reason: 'Memory B restates memory A with less detail',
};

describe('adjudicateConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropic.mockReturnValue(
      vi.fn(() => 'mock-model') as ReturnType<typeof createAnthropic>,
    );
  });

  it('returns the adjudication decision', async () => {
    mockGenerateText.mockResolvedValueOnce({ output: sampleDecision } as never);

    const result = await adjudicateConflict(makeMemory(), makeMemory(), config);

    expect(result.relation).toBe('duplicate');
    expect(result.action).toBe('supersede_b');
  });

  it('includes both memories in the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({ output: sampleDecision } as never);

    await adjudicateConflict(
      makeMemory({ content: 'User works at Acme Corp' }),
      makeMemory({ content: 'User is employed by Acme' }),
      config,
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('User works at Acme Corp');
    expect(call.prompt).toContain('User is employed by Acme');
  });

  it('passes the Claude output-token ceiling so adaptive thinking cannot starve structured output', async () => {
    mockGenerateText.mockResolvedValueOnce({ output: sampleDecision } as never);

    await adjudicateConflict(makeMemory(), makeMemory(), config);

    expect(mockGenerateText.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    });
  });

  it('uses custom model when specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({ output: sampleDecision } as never);

    await adjudicateConflict(makeMemory(), makeMemory(), {
      ...config,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(modelFn).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });
});
