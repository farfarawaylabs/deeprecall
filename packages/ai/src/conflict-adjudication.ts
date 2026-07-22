import { generateText, Output } from 'ai';
import { CLAUDE_MAX_OUTPUT_TOKENS, createClaudeModel, type ClaudeConfig } from './claude';
import { z } from 'zod';
import type { Memory } from '@deeprecall/types';
import { CONFLICT_ADJUDICATION_PROMPT } from './prompts/conflict-adjudication';

const DEFAULT_MODEL = 'claude-sonnet-5';

/** Configuration for the conflict adjudication LLM call. */
export interface ConflictAdjudicationConfig {
  claude: ClaudeConfig;
  model?: string;
}

const ConflictAdjudicationSchema = z.object({
  relation: z
    .enum(['distinct', 'duplicate', 'contradiction'])
    .describe('How the two memories actually relate'),
  action: z
    .enum(['keep_both', 'supersede_a', 'supersede_b', 'merge'])
    .describe('What should happen to the pair'),
  merged_content: z
    .string()
    .nullable()
    .describe('Self-contained combined content when action is merge (null otherwise)'),
  reason: z.string().describe('Brief explanation of the adjudication'),
});

export type ConflictAdjudication = z.infer<typeof ConflictAdjudicationSchema>;

function memoryView(memory: Memory): string {
  return JSON.stringify(
    {
      content: memory.content,
      type: memory.type,
      subject: memory.subject,
      source_type: memory.source_type,
      confidence: memory.confidence,
      validity_start: memory.validity_start,
      validity_end: memory.validity_end,
      created_at: memory.created_at,
    },
    null,
    2,
  );
}

/**
 * Use LLM to adjudicate a pair of similar memories: distinct facts to keep,
 * a redundant duplicate to retire, or a contradiction to merge. Similarity
 * alone is never treated as contradiction — that decision destroyed distinct
 * events and specific facts when it was rule-based.
 */
export async function adjudicateConflict(
  memoryA: Memory,
  memoryB: Memory,
  config: ConflictAdjudicationConfig,
): Promise<ConflictAdjudication> {
  const model = createClaudeModel(config.model ?? DEFAULT_MODEL, config.claude);

  const prompt = CONFLICT_ADJUDICATION_PROMPT.replace('{memory_a}', () =>
    memoryView(memoryA),
  ).replace('{memory_b}', () => memoryView(memoryB));

  const { output } = await generateText({
    model,
    output: Output.object({ schema: ConflictAdjudicationSchema }),
    prompt,
    maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
  });

  return output;
}
