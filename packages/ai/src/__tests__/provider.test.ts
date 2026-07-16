import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three provider factories. Each returns a model factory that echoes
// the model id it was called with, so we can assert routing without any network.
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn((id: string) => `anthropic-model:${id}`)),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((id: string) => `openai-model:${id}`)),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn((id: string) => `google-model:${id}`)),
}));

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { parseModelSpec, resolveModel } from '../provider';

const mockCreateAnthropic = vi.mocked(createAnthropic);
const mockCreateOpenAI = vi.mocked(createOpenAI);
const mockCreateGoogle = vi.mocked(createGoogleGenerativeAI);

describe('parseModelSpec', () => {
  it('parses a well-formed spec', () => {
    expect(parseModelSpec('anthropic:claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });

  it('splits on the first colon only (preserves colons in the model id)', () => {
    expect(parseModelSpec('openai:gpt-5:preview')).toEqual({
      provider: 'openai',
      modelId: 'gpt-5:preview',
    });
  });

  it('lowercases the provider and trims whitespace', () => {
    expect(parseModelSpec('  Anthropic : claude-opus-4-8 ')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
    });
  });

  it('throws when there is no colon', () => {
    expect(() => parseModelSpec('claude-opus-4-8')).toThrow(/expected/);
  });

  it('throws on an unknown provider', () => {
    expect(() => parseModelSpec('cohere:command-r')).toThrow(/Unknown model provider/);
  });

  it('throws when the model id is empty', () => {
    expect(() => parseModelSpec('anthropic:')).toThrow(/missing model id/);
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes anthropic specs to createAnthropic with the anthropic key', () => {
    const model = resolveModel('anthropic:claude-opus-4-8', {
      anthropic: 'ak',
    });
    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'ak' });
    expect(model).toBe('anthropic-model:claude-opus-4-8');
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
    expect(mockCreateGoogle).not.toHaveBeenCalled();
  });

  it('routes openai specs to createOpenAI with the openai key', () => {
    const model = resolveModel('openai:gpt-5', { openai: 'ok' });
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'ok' });
    expect(model).toBe('openai-model:gpt-5');
  });

  it('routes google specs to createGoogleGenerativeAI with the google key', () => {
    const model = resolveModel('google:gemini-3-pro', { google: 'gk' });
    expect(mockCreateGoogle).toHaveBeenCalledWith({ apiKey: 'gk' });
    expect(model).toBe('google-model:gemini-3-pro');
  });

  it("only requires the selected provider's key", () => {
    // No openai/google keys present, but anthropic is selected — should succeed.
    expect(() => resolveModel('anthropic:claude-opus-4-8', { anthropic: 'ak' })).not.toThrow();
  });

  it("throws a clear error when the selected provider's key is missing", () => {
    expect(() => resolveModel('openai:gpt-5', { anthropic: 'ak' })).toThrow(
      /Missing API key for provider "openai"/,
    );
  });
});
