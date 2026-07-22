import type { AnswerRequest, AnswerResponse, QueryResponse } from '@deeprecall/types';
import {
  CLAUDE_MAX_OUTPUT_TOKENS,
  generateAnswer,
  parseModelSpec,
  claudeConfigFromEnv,
  type ProviderKeys,
} from '@deeprecall/ai';
import { internalFetch } from '@deeprecall/http';

/**
 * Fallback answer model when neither the product config nor the ANSWER_MODEL
 * env var specifies one. Sonnet 5 — best speed/intelligence balance for the
 * answer path. Override per-product via KV or per-env via the ANSWER_MODEL var.
 */
const DEFAULT_ANSWER_MODEL = 'anthropic:claude-sonnet-5';

/**
 * Generous default answer budget for **Anthropic** answer models when the caller
 * omits `max_tokens`. Anthropic models run adaptive thinking by default (Sonnet
 * 5+), and thinking shares this budget — so the default must be large enough that
 * thinking never starves the answer (a small budget yields a "No output
 * generated" MODEL_ERROR). Grounded answers are short, so a high ceiling costs
 * nothing for normal responses (the model stops at end_turn long before it) and
 * simply avoids truncating the rare long answer. Valid for every Anthropic answer
 * model (Haiku 4.5 = 64K output, Opus/Sonnet = 128K). Applied to Anthropic only —
 * OpenAI/Google have no default thinking and lower output caps, so they use their
 * own in-range provider default instead (a fixed value would exceed some of them).
 * Shares CLAUDE_MAX_OUTPUT_TOKENS with the internal pipeline calls so the two
 * ceilings cannot drift.
 */
const DEFAULT_ANSWER_MAX_TOKENS = CLAUDE_MAX_OUTPUT_TOKENS;

export interface AnswerContext {
  env: Env;
  productId: string;
  traceId: string;
}

/**
 * An upstream dependency of /v1/answer failed (retrieval worker or the model
 * provider). Carries an HTTP status + machine code so the route can surface a
 * distinct, actionable error instead of a blanket 500.
 */
export class AnswerUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: 502,
    readonly code: 'RETRIEVAL_ERROR' | 'MODEL_ERROR',
  ) {
    super(message);
    this.name = 'AnswerUpstreamError';
  }
}

/** Assemble provider keys from env. Only the selected provider's key is used. */
function providerKeys(env: Env): ProviderKeys {
  return {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    google: env.GOOGLE_API_KEY,
    // Routes "anthropic:" model specs to the configured Claude runtime
    // (ANTHROPIC_PROVIDER: bedrock default, or the direct Anthropic API).
    claude: claudeConfigFromEnv(env),
  };
}

/**
 * Resolve the model spec for a product.
 * Precedence: product KV config (`answer_model`) → ANSWER_MODEL env → default.
 * The `answer_model` field is written at onboarding by the management worker.
 */
async function resolveAnswerModel(env: Env, productId: string): Promise<string> {
  const configStr = await env.CONFIG.get(`product:${productId}:config`);
  if (configStr) {
    try {
      const config = JSON.parse(configStr) as { answer_model?: unknown };
      if (typeof config.answer_model === 'string' && config.answer_model) {
        return config.answer_model;
      }
    } catch {
      // Malformed config — fall through to env/default rather than failing.
    }
  }
  return env.ANSWER_MODEL || DEFAULT_ANSWER_MODEL;
}

/** Retrieve grounding memories via the retrieval worker (Service Binding). */
async function retrieveGrounding(req: AnswerRequest, ctx: AnswerContext): Promise<QueryResponse> {
  const envelope = {
    product_id: ctx.productId,
    query: req.question,
    scope: req.scope,
    mode: req.mode,
    top_k: req.top_k,
  };

  const response = await internalFetch(
    ctx.env.RETRIEVAL,
    new Request('https://internal/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-trace-id': ctx.traceId,
      },
      body: JSON.stringify(envelope),
    }),
    ctx.env.INTERNAL_SERVICE_KEY,
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new AnswerUpstreamError(
      `Retrieval failed (${response.status}) while answering: ${detail}`,
      502,
      'RETRIEVAL_ERROR',
    );
  }

  return (await response.json()) as QueryResponse;
}

/**
 * Answer a question grounded in the product's memories.
 *
 * Orchestration only: retrieval (fast, no LLM) then a single answer-generation
 * LLM call. Retrieval stays on the hot path untouched; the LLM cost is isolated
 * to this opt-in endpoint.
 */
export async function answerQuestion(
  req: AnswerRequest,
  ctx: AnswerContext,
): Promise<AnswerResponse> {
  const retrieval = await retrieveGrounding(req, ctx);
  const memories = retrieval.memories.map((scored) => scored.memory);

  const model = await resolveAnswerModel(ctx.env, ctx.productId);

  let result;
  try {
    // Apply the generous default only to Anthropic (thinking-by-default shares
    // the budget). Other providers use their own in-range default via undefined,
    // since a fixed high ceiling exceeds some OpenAI/Google models' output caps.
    const { provider } = parseModelSpec(model);
    const maxOutputTokens =
      req.max_tokens ?? (provider === 'anthropic' ? DEFAULT_ANSWER_MAX_TOKENS : undefined);

    result = await generateAnswer(req.question, memories, {
      model,
      keys: providerKeys(ctx.env),
      maxOutputTokens,
    });
  } catch (err) {
    // Model spec/key misconfig or a provider-side failure — distinguish from a
    // genuine internal crash. The underlying detail is logged, not returned.
    throw new AnswerUpstreamError(
      `Answer model "${model}" failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
      'MODEL_ERROR',
    );
  }

  return {
    answer: result.answer,
    based_on: result.based_on,
    memories: retrieval.memories,
    model,
    usage: {
      input_tokens: result.usage.inputTokens ?? null,
      output_tokens: result.usage.outputTokens ?? null,
    },
  };
}
