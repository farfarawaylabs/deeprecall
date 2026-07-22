import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryCandidate as MemoryCandidateType } from '@deeprecall/types';
import type { ExtractionConfig } from '../types';

// Mock the ai and @ai-sdk/anthropic modules before importing.
// Output.object is a pass-through so tests can assert the schema that was passed.
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
import { extractMemories } from '../extraction';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../claude';

const mockGenerateText = vi.mocked(generateText);
const mockCreateAnthropic = vi.mocked(createAnthropic);

const baseConfig: ExtractionConfig = {
  claude: { provider: 'anthropic', apiKey: 'test-api-key' },
  sceneType: 'one_on_one_chat',
};

const sampleCandidate: MemoryCandidateType = {
  content: 'User prefers TypeScript over JavaScript',
  episode: null,
  type: 'fact',
  source_actor: 'user',
  source_type: 'user_stated',
  confidence: 0.9,
  validity_start: null,
  validity_end: null,
  tags: ['preference', 'programming'],
  subject: 'user',
  predicate: 'prefers',
  object: 'TypeScript',
};

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropic.mockReturnValue(
      vi.fn(() => 'mock-model') as ReturnType<typeof createAnthropic>,
    );
  });

  it('returns extracted memory candidates', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [sampleCandidate] },
    } as never);

    const result = await extractMemories('User: I prefer TypeScript', baseConfig);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('User prefers TypeScript over JavaScript');
    expect(result[0].type).toBe('fact');
    expect(result[0].source_type).toBe('user_stated');
  });

  it('passes the Claude output-token ceiling so adaptive thinking cannot starve structured output', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test content', baseConfig);

    expect(mockGenerateText.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    });
  });

  it('creates Anthropic provider with the API key', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test content', baseConfig);

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
  });

  it('uses default model when none specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test content', baseConfig);

    expect(modelFn).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('uses custom model when specified', async () => {
    const modelFn = vi.fn(() => 'mock-model');
    mockCreateAnthropic.mockReturnValue(modelFn as ReturnType<typeof createAnthropic>);
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test', { ...baseConfig, model: 'claude-haiku-4-5-20251001' });

    expect(modelFn).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it('default template carries the verbatim-names rule', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories("Tim: I'm excited about that new show!", baseConfig);

    const call = mockGenerateText.mock.calls[0][0];
    // Guards the proper-noun preservation rule: memories must never store
    // a deictic reference ("that show") when the conversation names the
    // thing — losing the name loses the information.
    expect(call.prompt).toContain('Preserve names verbatim');
    expect(call.prompt).toContain('resolve the reference');
  });

  it('replaces {content} placeholder in template', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories("Hello, I'm testing", baseConfig);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain("Hello, I'm testing");
  });

  it('uses custom template when provided', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    const customTemplate = 'Extract facts from: {content}';
    await extractMemories('test', { ...baseConfig, template: customTemplate });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toBe('Extract facts from: test');
  });

  it('interpolates referenceTime into the {reference_time} placeholder', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('Melanie: I went camping last weekend', {
      ...baseConfig,
      referenceTime: '2023-05-08T13:56:00Z',
    });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain(
      'Reference time (when this conversation took place): 2023-05-08T13:56:00Z',
    );
    expect(call.prompt).not.toContain('{reference_time}');
  });

  it('falls back to in-conversation anchoring when referenceTime is absent', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test content', baseConfig);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('not provided — anchor to dates stated inside the conversation');
    expect(call.prompt).not.toContain('{reference_time}');
  });

  it('interpolates referenceTime in a custom template that uses the placeholder', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test', {
      ...baseConfig,
      template: 'At {reference_time}, extract from: {content}',
      referenceTime: '2023-10-22T09:55:00Z',
    });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toBe('At 2023-10-22T09:55:00Z, extract from: test');
  });

  it('inserts content containing $-replacement patterns literally', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    const content = 'User: my shell prompt is $` and I use $& in regexes {reference_time}';
    await extractMemories(content, {
      ...baseConfig,
      referenceTime: '2023-05-08T13:56:00Z',
    });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain(content);
    // the template's own placeholder was already consumed, not the copy in content
    expect(call.prompt).toContain(
      'Reference time (when this conversation took place): 2023-05-08T13:56:00Z',
    );
  });

  it('returns empty array when no memories extracted', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    const result = await extractMemories('Hello, nice weather', baseConfig);

    expect(result).toEqual([]);
  });

  it('handles multiple extracted candidates', async () => {
    const candidates: MemoryCandidateType[] = [
      { ...sampleCandidate, content: 'Fact 1' },
      { ...sampleCandidate, content: 'Fact 2', type: 'foresight' },
    ];
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: candidates },
    } as never);

    const result = await extractMemories('conversation text', baseConfig);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Fact 1');
    expect(result[1].type).toBe('foresight');
  });

  it('passes schema via Output.object to generateText', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { memories: [] },
    } as never);

    await extractMemories('test', baseConfig);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toBe('mock-model');
    // Output.object is mocked as pass-through, so call.output is the config we passed in.
    expect(call.output).toMatchObject({ schema: expect.anything() });
  });

  it('propagates API errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    await expect(extractMemories('test', baseConfig)).rejects.toThrow('API rate limit exceeded');
  });
});
