import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'anthropic-model')),
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: vi.fn(() => vi.fn(() => 'bedrock-model')),
}));

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createClaudeModel, claudeConfigFromEnv, toBedrockModelId } from '../claude';

const mockCreateAnthropic = vi.mocked(createAnthropic);
const mockCreateBedrock = vi.mocked(createAmazonBedrock);

const bedrockCreds = {
  region: 'us-east-1',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'shh',
};

describe('toBedrockModelId', () => {
  it('maps bare first-party ids to geo inference profiles', () => {
    expect(toBedrockModelId('claude-sonnet-5', 'us-east-1')).toBe('us.anthropic.claude-sonnet-5');
    expect(toBedrockModelId('claude-opus-4-8', 'us-west-2')).toBe('us.anthropic.claude-opus-4-8');
    expect(toBedrockModelId('claude-sonnet-5', 'eu-west-1')).toBe('eu.anthropic.claude-sonnet-5');
    expect(toBedrockModelId('claude-sonnet-5', 'ap-northeast-1')).toBe(
      'apac.anthropic.claude-sonnet-5',
    );
  });

  it('appends -v1:0 to dated snapshot ids (pre-4.6 convention)', () => {
    expect(toBedrockModelId('claude-haiku-4-5-20251001', 'us-east-1')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('maps opus-4-6 to its special -v1 id', () => {
    expect(toBedrockModelId('claude-opus-4-6', 'us-east-1')).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    );
  });

  it('prefers an explicit override over any convention', () => {
    expect(
      toBedrockModelId('claude-sonnet-5', 'us-east-1', {
        'claude-sonnet-5': 'global.anthropic.claude-sonnet-5',
      }),
    ).toBe('global.anthropic.claude-sonnet-5');
  });

  it('passes through already-prefixed, geo, global and ARN ids', () => {
    expect(toBedrockModelId('anthropic.claude-sonnet-5', 'us-east-1')).toBe(
      'anthropic.claude-sonnet-5',
    );
    expect(toBedrockModelId('us.anthropic.claude-sonnet-5', 'eu-west-1')).toBe(
      'us.anthropic.claude-sonnet-5',
    );
    expect(toBedrockModelId('global.anthropic.claude-sonnet-5', 'us-east-1')).toBe(
      'global.anthropic.claude-sonnet-5',
    );
    expect(toBedrockModelId('arn:aws:bedrock:us-east-1::foo', 'us-east-1')).toBe(
      'arn:aws:bedrock:us-east-1::foo',
    );
  });
});

describe('createClaudeModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAnthropic.mockReturnValue(
      vi.fn(() => 'anthropic-model') as unknown as ReturnType<typeof createAnthropic>,
    );
    mockCreateBedrock.mockReturnValue(
      vi.fn(() => 'bedrock-model') as unknown as ReturnType<typeof createAmazonBedrock>,
    );
  });

  it('defaults to bedrock', () => {
    const modelFn = vi.fn(() => 'bedrock-model');
    mockCreateBedrock.mockReturnValue(modelFn as unknown as ReturnType<typeof createAmazonBedrock>);

    createClaudeModel('claude-sonnet-5', { bedrock: bedrockCreds });

    expect(mockCreateBedrock).toHaveBeenCalledWith({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'shh',
      sessionToken: undefined,
    });
    expect(modelFn).toHaveBeenCalledWith('us.anthropic.claude-sonnet-5');
    expect(mockCreateAnthropic).not.toHaveBeenCalled();
  });

  it('uses the direct Anthropic API when provider is anthropic', () => {
    const modelFn = vi.fn(() => 'anthropic-model');
    mockCreateAnthropic.mockReturnValue(modelFn as unknown as ReturnType<typeof createAnthropic>);

    createClaudeModel('claude-sonnet-5', {
      provider: 'anthropic',
      apiKey: 'sk-test',
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    expect(modelFn).toHaveBeenCalledWith('claude-sonnet-5'); // no prefix
    expect(mockCreateBedrock).not.toHaveBeenCalled();
  });

  it('fails fast when bedrock credentials are missing', () => {
    expect(() => createClaudeModel('claude-sonnet-5', {})).toThrow(/AWS credentials are missing/);
  });

  it('fails fast when anthropic key is missing', () => {
    expect(() => createClaudeModel('claude-sonnet-5', { provider: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY is missing/,
    );
  });
});

describe('claudeConfigFromEnv', () => {
  it('defaults to bedrock and picks up AWS vars', () => {
    const cfg = claudeConfigFromEnv({
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.provider).toBe('bedrock');
    expect(cfg.bedrock?.region).toBe('eu-west-1');
  });

  it('selects anthropic when ANTHROPIC_PROVIDER says so', () => {
    const cfg = claudeConfigFromEnv({
      ANTHROPIC_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-x',
    });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.apiKey).toBe('sk-x');
    expect(cfg.bedrock).toBeUndefined();
  });

  it('rejects unknown provider values', () => {
    expect(() => claudeConfigFromEnv({ ANTHROPIC_PROVIDER: 'azure' })).toThrow(
      /Invalid ANTHROPIC_PROVIDER/,
    );
  });

  it('normalizes case and whitespace', () => {
    expect(claudeConfigFromEnv({ ANTHROPIC_PROVIDER: ' Bedrock ' }).provider).toBe('bedrock');
  });
});
