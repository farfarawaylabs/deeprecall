import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Memory } from '@deeprecall/types';
import { resolveModel, type ProviderKeys } from './provider';
import { ANSWER_PROMPT } from './prompts/answer';

export interface AnswerConfig {
  /** Model spec `<provider>:<model-id>`, e.g. "anthropic:claude-opus-4-8". */
  model: string;
  /** Provider API keys — only the selected provider's key is required. */
  keys: ProviderKeys;
  /** Upper bound on generated answer tokens. */
  maxOutputTokens?: number;
}

export interface AnswerResult {
  /** The grounded natural-language answer. */
  answer: string;
  /** Memory ids the answer is grounded in (validated subset of the input). */
  based_on: string[];
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  };
}

const AnswerOutput = z.object({
  answer: z.string(),
  based_on: z.array(z.string()),
});

function formatMemory(memory: Memory): string {
  // No timestamp in the render: extraction resolves dates into the content
  // itself (the single temporal source of truth). A second, structured date
  // field invites the model to re-derive offsets and mislabel event dates as
  // conversation dates — and updated_at is ingest wall-clock, meaningless for
  // bulk-imported histories.
  return `[${memory.id}] (type: ${memory.type}, confidence: ${memory.confidence}) ${memory.content}`;
}

/** Strip stray surrounding brackets/whitespace from a model-returned citation id. */
function normalizeCitation(id: string): string {
  return id
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .trim();
}

/**
 * Generate a grounded natural-language answer from retrieved memories.
 *
 * The answer must be supported only by the provided memories. `based_on` is
 * validated against the supplied ids, so the model cannot cite anything it was
 * not given — an anti-hallucination guardrail on the citation set.
 */
export async function generateAnswer(
  question: string,
  memories: Memory[],
  config: AnswerConfig,
): Promise<AnswerResult> {
  const model = resolveModel(config.model, config.keys);

  const memoryBlock =
    memories.length > 0 ? memories.map(formatMemory).join('\n') : '(no memories found)';

  // Single-pass replace with a function replacer. This fills each placeholder
  // exactly once (a plain `.replace(str, str)` only replaces the first match, so
  // a `{memories}` token inside the question could hijack the memory slot), and
  // avoids `$`-pattern interpretation in the untrusted question/memory content.
  const prompt = ANSWER_PROMPT.replace(/\{(question|memories)\}/g, (_match, key: string) =>
    key === 'question' ? question : memoryBlock,
  );

  const { output, usage } = await generateText({
    model,
    output: Output.object({ schema: AnswerOutput }),
    prompt,
    maxOutputTokens: config.maxOutputTokens,
  });

  // Citation guardrail: the model can only cite memories it was actually given.
  // Normalize each returned id (strip stray brackets/whitespace) before the
  // membership check, and dedupe, so a well-grounded answer isn't dropped over
  // formatting noise.
  const providedIds = new Set(memories.map((m) => m.id));
  const based_on = [
    ...new Set(output.based_on.map(normalizeCitation).filter((id) => providedIds.has(id))),
  ];

  return {
    answer: output.answer,
    based_on,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}
