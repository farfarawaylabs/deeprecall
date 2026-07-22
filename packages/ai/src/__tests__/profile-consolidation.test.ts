import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { consolidateProfile } from '../profile-consolidation';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../claude';
import type { ProfileConsolidationConfig } from '../profile-consolidation';

const mockGenerateText = vi.mocked(generateText);
const mockCreateAnthropic = vi.mocked(createAnthropic);

const config: ProfileConsolidationConfig = {
  claude: { provider: 'anthropic' as const, apiKey: 'test-key' },
};

function makeFact(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    content: 'User likes coding',
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

describe('consolidateProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropic.mockReturnValue(
      vi.fn(() => 'mock-model') as ReturnType<typeof createAnthropic>,
    );
  });

  it('passes the Claude output-token ceiling so adaptive thinking cannot starve the summary', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'profile' } as never);

    await consolidateProfile([makeFact()], config);

    expect(mockGenerateText.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    });
  });

  it('returns consolidated profile text', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'The user is a software developer who enjoys TypeScript.',
    } as never);

    const facts = [
      makeFact({ content: 'User is a software developer' }),
      makeFact({ content: 'User enjoys TypeScript' }),
    ];

    const result = await consolidateProfile(facts, config);

    expect(result).toBe('The user is a software developer who enjoys TypeScript.');
  });

  it('formats facts with index, confidence, source, and date', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Profile summary',
    } as never);

    const facts = [
      makeFact({
        content: 'Likes dogs',
        confidence: 0.95,
        source_type: 'user_stated',
        updated_at: '2025-06-15T10:00:00.000Z',
      }),
    ];

    await consolidateProfile(facts, config);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('1.');
    expect(call.prompt).toContain('confidence: 0.95');
    expect(call.prompt).toContain('source: user_stated');
    expect(call.prompt).toContain('updated: 2025-06-15T10:00:00.000Z');
    expect(call.prompt).toContain('Likes dogs');
  });

  it('includes all facts in prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '' } as never);

    const facts = [
      makeFact({ content: 'Fact A' }),
      makeFact({ content: 'Fact B' }),
      makeFact({ content: 'Fact C' }),
    ];

    await consolidateProfile(facts, config);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('Fact A');
    expect(call.prompt).toContain('Fact B');
    expect(call.prompt).toContain('Fact C');
    expect(call.prompt).toContain('1.');
    expect(call.prompt).toContain('2.');
    expect(call.prompt).toContain('3.');
  });

  it('uses default model when none specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({ text: '' } as never);

    await consolidateProfile([makeFact()], config);

    expect(modelFn).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('uses custom model when specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({ text: '' } as never);

    await consolidateProfile([makeFact()], { ...config, model: 'claude-haiku-4-5-20251001' });

    expect(modelFn).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it('creates Anthropic provider with API key', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '' } as never);

    await consolidateProfile([makeFact()], {
      claude: { provider: 'anthropic', apiKey: 'my-secret-key' },
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'my-secret-key' });
  });

  it('propagates API errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Service unavailable'));

    await expect(consolidateProfile([makeFact()], config)).rejects.toThrow('Service unavailable');
  });
});
