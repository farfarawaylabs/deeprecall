import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModel } from 'ai';

/**
 * Where Anthropic models run: directly against the Anthropic API, or via
 * AWS Bedrock. Selected per-deployment with the ANTHROPIC_PROVIDER env var.
 */
export type ClaudeProvider = 'anthropic' | 'bedrock';

const DEFAULT_PROVIDER: ClaudeProvider = 'bedrock';

interface BedrockCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Optional first-party-id → Bedrock-id map (from BEDROCK_MODEL_OVERRIDES),
   * for when a model needs a versioned or inference-profile id that the
   * default `anthropic.` prefixing doesn't produce. Operational escape
   * hatch — no code change needed to repin a model.
   */
  modelIdOverrides?: Record<string, string>;
}

/**
 * Output-token ceiling for internal Claude calls (extraction, reconciliation,
 * adjudication, consolidation). Claude Sonnet 5 runs adaptive thinking by
 * default and thinking tokens share the output budget; without an explicit
 * ceiling the provider default (~4k) can be consumed by thinking before the
 * structured output is emitted, surfacing as AI_NoOutputGeneratedError on
 * dense inputs. 64000 mirrors the /v1/answer Anthropic default — generous
 * headroom for thinking plus large structured outputs, within Sonnet 5's
 * 128k output cap. Note: pinning a per-call model (config.model or
 * BEDROCK_MODEL_OVERRIDES) with an output cap below this value makes the
 * provider reject every request — keep overrides on models with >= 64k output.
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

/** Runtime configuration for instantiating Claude models. */
export interface ClaudeConfig {
  /** Defaults to "bedrock". */
  provider?: ClaudeProvider;
  /** Anthropic API key — required when provider is "anthropic". */
  apiKey?: string;
  /** AWS credentials — required when provider is "bedrock". */
  bedrock?: BedrockCredentials;
}

/** Geo prefix for Bedrock cross-region inference profiles, from the AWS region. */
function bedrockGeoPrefix(region: string): string {
  if (region.startsWith('eu-')) return 'eu.';
  if (region.startsWith('ap-')) return 'apac.';
  return 'us.'; // us-, ca-, sa- regions route via the US geo profiles
}

/**
 * Map a first-party Anthropic model id to its Bedrock INFERENCE PROFILE id.
 * Current Claude models on Bedrock don't support on-demand invocation by the
 * bare foundation-model id ("Invocation of model ID anthropic.claude-sonnet-5
 * with on-demand throughput isn't supported") — they must be called through a
 * geo inference profile: `<geo>.anthropic.<id>` (e.g.
 * `us.anthropic.claude-sonnet-5`). Naming follows the official scheme
 * (platform.claude.com → Model IDs and versioning):
 * - 4.6-generation and later (dateless ids): `<geo>.anthropic.<id>` verbatim.
 * - Dated snapshots (pre-4.6): `<geo>.anthropic.<id>-v1:0`.
 * - Opus 4.6 is the one dateless id that kept a suffix: `...-opus-4-6-v1`.
 * Ids already carrying a provider/region/global prefix (`anthropic.`,
 * `us.anthropic.`, `global.anthropic.`, ARN-style) pass through unchanged so
 * callers can pin exact Bedrock ids, and BEDROCK_MODEL_OVERRIDES wins over
 * every convention.
 */
export function toBedrockModelId(
  modelId: string,
  region: string,
  overrides?: Record<string, string>,
): string {
  if (overrides?.[modelId]) return overrides[modelId];
  if (
    modelId.startsWith('anthropic.') ||
    /^[a-z]{2,6}\.anthropic\./.test(modelId) || // geo/global profiles (us., eu., apac., global.)
    modelId.startsWith('arn:')
  ) {
    return modelId;
  }
  const geo = bedrockGeoPrefix(region);
  if (modelId === 'claude-opus-4-6') return `${geo}anthropic.claude-opus-4-6-v1`;
  if (/-\d{8}$/.test(modelId)) return `${geo}anthropic.${modelId}-v1:0`;
  return `${geo}anthropic.${modelId}`;
}

/**
 * Instantiate a Claude language model on the configured provider. This is the
 * single seam between "we use Claude models" and "where they run" — call
 * sites pass first-party model ids (`claude-sonnet-5`) regardless of provider.
 */
export function createClaudeModel(modelId: string, config: ClaudeConfig): LanguageModel {
  const provider = config.provider ?? DEFAULT_PROVIDER;

  if (provider === 'bedrock') {
    const creds = config.bedrock;
    if (!creds?.region || !creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error(
        "Claude provider is 'bedrock' but AWS credentials are missing. " +
          'Set AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY ' +
          "(or switch ANTHROPIC_PROVIDER to 'anthropic').",
      );
    }
    const bedrock = createAmazonBedrock({
      region: creds.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    return bedrock(toBedrockModelId(modelId, creds.region, creds.modelIdOverrides));
  }

  if (!config.apiKey) {
    throw new Error("Claude provider is 'anthropic' but ANTHROPIC_API_KEY is missing.");
  }
  return createAnthropic({ apiKey: config.apiKey })(modelId);
}

/** The env vars the Claude runtime reads. All workers share this shape. */
export interface ClaudeEnv {
  ANTHROPIC_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  /** Optional JSON map of first-party model id → Bedrock model id. */
  BEDROCK_MODEL_OVERRIDES?: string;
}

function parseModelOverrides(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  throw new Error('BEDROCK_MODEL_OVERRIDES must be a JSON object mapping model ids.');
}

/**
 * Build a ClaudeConfig from worker env vars.
 * ANTHROPIC_PROVIDER selects the runtime ("bedrock" default, "anthropic"
 * for the direct API); credentials for the selected provider must be set.
 */
export function claudeConfigFromEnv(env: ClaudeEnv): ClaudeConfig {
  const raw = env.ANTHROPIC_PROVIDER?.trim().toLowerCase() || DEFAULT_PROVIDER;
  if (raw !== 'anthropic' && raw !== 'bedrock') {
    throw new Error(`Invalid ANTHROPIC_PROVIDER "${raw}": expected "anthropic" or "bedrock".`);
  }
  return {
    provider: raw,
    apiKey: env.ANTHROPIC_API_KEY,
    bedrock:
      env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            region: env.AWS_REGION,
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            sessionToken: env.AWS_SESSION_TOKEN,
            modelIdOverrides: parseModelOverrides(env.BEDROCK_MODEL_OVERRIDES),
          }
        : undefined,
  };
}
