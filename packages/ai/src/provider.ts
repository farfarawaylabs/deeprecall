import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { createClaudeModel, type ClaudeConfig } from './claude';

/** Providers the resolver can instantiate. */
export type ProviderName = 'anthropic' | 'openai' | 'google';

const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

/** API keys per provider. Only the key for the selected provider is required. */
export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  google?: string;
  /**
   * Claude runtime for "anthropic:" specs. When set, it decides whether the
   * model runs on the direct Anthropic API or AWS Bedrock; when absent, the
   * direct API is used with the `anthropic` key.
   */
  claude?: ClaudeConfig;
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Parse a model spec of the form `<provider>:<model-id>`.
 *
 * Examples: `anthropic:claude-opus-4-8`, `openai:gpt-5`, `google:gemini-3-pro`.
 * Splits on the first colon only, so model ids containing colons are preserved.
 */
export function parseModelSpec(spec: string): {
  provider: ProviderName;
  modelId: string;
} {
  const separator = spec.indexOf(':');
  if (separator === -1) {
    throw new Error(
      `Invalid model spec "${spec}": expected "<provider>:<model-id>" (e.g. "anthropic:claude-opus-4-8")`,
    );
  }

  const provider = spec.slice(0, separator).trim().toLowerCase();
  const modelId = spec.slice(separator + 1).trim();

  if (!isProviderName(provider)) {
    throw new Error(
      `Unknown model provider "${provider}" in spec "${spec}". Supported: ${PROVIDERS.join(', ')}`,
    );
  }
  if (!modelId) {
    throw new Error(`Invalid model spec "${spec}": missing model id after "${provider}:"`);
  }

  return { provider, modelId };
}

function requireKey(key: string | undefined, provider: ProviderName): string {
  if (!key) {
    throw new Error(
      `Missing API key for provider "${provider}". Set the corresponding secret to use this model.`,
    );
  }
  return key;
}

/**
 * Resolve a `<provider>:<model-id>` spec plus provider keys into a Vercel AI SDK
 * language model. This is the single seam for swapping models across providers
 * (Anthropic / OpenAI / Google) without touching call-site logic.
 *
 * @throws if the spec is malformed or the required provider key is missing.
 */
export function resolveModel(spec: string, keys: ProviderKeys): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);

  switch (provider) {
    case 'anthropic':
      return createClaudeModel(
        modelId,
        keys.claude ?? {
          provider: 'anthropic',
          apiKey: requireKey(keys.anthropic, provider),
        },
      );
    case 'openai':
      return createOpenAI({ apiKey: requireKey(keys.openai, provider) })(modelId);
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: requireKey(keys.google, provider),
      })(modelId);
  }
}
