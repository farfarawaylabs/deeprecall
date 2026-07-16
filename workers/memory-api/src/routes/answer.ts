import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import { AnswerRequest } from '@deeprecall/types';
import { Logger } from '@deeprecall/logger';
import type { AppBindings } from '../types';
import { answerQuestion, AnswerUpstreamError } from '../answer/answer-service';

const answer = new Hono<AppBindings>();

/**
 * POST /v1/answer
 * Answer a question grounded in the product's memories.
 *
 * Opt-in reasoning endpoint: retrieves memories (fast, no LLM) then makes a
 * single answer-generation LLM call. Slower than /v1/query by design — callers
 * choose it only when they want a synthesized, citation-grounded answer.
 *
 * product_id is injected from the API key (auth middleware); callers cannot
 * spoof it via the request body.
 */
answer.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = AnswerRequest.safeParse(body);

  if (!parsed.success) {
    return apiError(c, 400, 'VALIDATION_ERROR', 'Invalid request body', parsed.error.flatten());
  }

  try {
    const result = await answerQuestion(parsed.data, {
      env: c.env,
      productId: c.get('product_id'),
      traceId: c.get('trace_id'),
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof AnswerUpstreamError) {
      // Log the detailed cause; return a categorized code without leaking internals.
      Logger.error(c.get('log_ctx'), 'Answer upstream failure', {
        error: err.message,
        code: err.code,
      });
      return apiError(
        c,
        err.status,
        err.code,
        err.code === 'MODEL_ERROR'
          ? 'The answer model failed to generate a response.'
          : 'Failed to retrieve grounding memories for the answer.',
      );
    }
    throw err;
  }
});

export { answer };
