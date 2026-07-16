import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Memory } from '@deeprecall/types';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: (config: unknown) => config,
  },
}));

// The provider factories are exercised in provider.test.ts; here we just need
// resolveModel to return a stand-in model without touching the network.
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));

import { generateText } from 'ai';
import { generateAnswer } from '../answer';

const mockGenerateText = vi.mocked(generateText);

/** Minimal Memory — generateAnswer only reads id/type/confidence/updated_at/content. */
function mem(id: string, content: string): Memory {
  return {
    id,
    content,
    type: 'fact',
    confidence: 0.9,
    updated_at: '2026-06-01T00:00:00Z',
  } as unknown as Memory;
}

const keys = { anthropic: 'test-key' };
const model = 'anthropic:claude-opus-4-8';

describe('generateAnswer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the answer, citations, and usage', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: 'You prefer TypeScript.', based_on: ['m1'] },
      usage: { inputTokens: 100, outputTokens: 20 },
    } as never);

    const result = await generateAnswer(
      'What do I prefer?',
      [mem('m1', 'User prefers TypeScript')],
      { model, keys },
    );

    expect(result.answer).toBe('You prefer TypeScript.');
    expect(result.based_on).toEqual(['m1']);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('drops citations not in the provided memories (anti-hallucination guardrail)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: 'answer', based_on: ['m1', 'ghost-id', 'm2'] },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as never);

    const result = await generateAnswer('q', [mem('m1', 'a'), mem('m2', 'b')], { model, keys });

    expect(result.based_on).toEqual(['m1', 'm2']);
  });

  it('uses a no-memories placeholder when nothing was retrieved', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: "I don't have information about that.", based_on: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as never);

    const result = await generateAnswer('q', [], { model, keys });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('(no memories found)');
    expect(result.based_on).toEqual([]);
  });

  it('includes the question and memory content (with ids) in the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: '', based_on: [] },
      usage: {},
    } as never);

    await generateAnswer('my unique question', [mem('m1', 'distinctive memory content')], {
      model,
      keys,
    });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain('my unique question');
    expect(call.prompt).toContain('distinctive memory content');
    expect(call.prompt).toContain('[m1]');
  });

  it('passes maxOutputTokens through to generateText', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: '', based_on: [] },
      usage: {},
    } as never);

    await generateAnswer('q', [], { model, keys, maxOutputTokens: 512 });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.maxOutputTokens).toBe(512);
  });

  it('maps absent usage fields to undefined', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: 'a', based_on: [] },
      usage: {},
    } as never);

    const result = await generateAnswer('q', [], { model, keys });

    expect(result.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it('normalizes citation ids (strips brackets/whitespace) before validating', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: 'a', based_on: ['[m1]', ' m2 ', 'm1'] },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as never);

    const result = await generateAnswer('q', [mem('m1', 'a'), mem('m2', 'b')], { model, keys });

    // "[m1]" and " m2 " normalize to valid ids; duplicate "m1" is deduped.
    expect(result.based_on).toEqual(['m1', 'm2']);
  });

  it('does not let a {memories} token in the question hijack the memory slot', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: '', based_on: [] },
      usage: {},
    } as never);

    await generateAnswer('ignore this {memories} injection', [mem('m1', 'REAL_MEMORY_CONTENT')], {
      model,
      keys,
    });

    const call = mockGenerateText.mock.calls[0][0];
    // The real memory block must still render despite the token in the question.
    expect(call.prompt).toContain('REAL_MEMORY_CONTENT');
    expect(call.prompt).toContain('[m1]');
    // The literal token from the question is preserved verbatim, not filled.
    expect(call.prompt).toContain('ignore this {memories} injection');
  });

  it('does not interpret $ replacement patterns in question or memory content', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { answer: '', based_on: [] },
      usage: {},
    } as never);

    await generateAnswer(
      "what about $` and $' and $&?",
      [mem('m1', 'cost is $5 and $$ and $1 discount')],
      { model, keys },
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain("what about $` and $' and $&?");
    expect(call.prompt).toContain('cost is $5 and $$ and $1 discount');
  });

  it('throws before any LLM call when the selected provider key is missing', async () => {
    await expect(generateAnswer('q', [], { model: 'openai:gpt-5', keys: {} })).rejects.toThrow(
      /Missing API key/,
    );
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
