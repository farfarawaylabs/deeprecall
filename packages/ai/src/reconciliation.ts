import { generateText, Output } from 'ai';
import { CLAUDE_MAX_OUTPUT_TOKENS, createClaudeModel, type ClaudeConfig } from './claude';
import { z } from 'zod';
import type { Memory, MemoryCandidate } from '@deeprecall/types';
import { RECONCILIATION_PROMPT } from './prompts/reconciliation';

const DEFAULT_MODEL = 'claude-sonnet-5';

/** An existing memory with its similarity score to the candidate. */
export interface SimilarMemory {
  memory: Memory;
  score: number;
}

/** Configuration for reconciliation LLM call. */
export interface ReconciliationConfig {
  claude: ClaudeConfig;
  model?: string;
}

const ReconciliationDecisionSchema = z.object({
  action: z.enum(['add', 'supersede', 'merge', 'skip']),
  reason: z.string().describe('Brief explanation of why this action was chosen'),
  existing_memory_id: z
    .string()
    .nullable()
    .describe('ID of the existing memory being superseded or merged with (null for add/skip)'),
  merged_content: z
    .string()
    .nullable()
    .describe('Combined content when action is merge (null otherwise)'),
});

export type ReconciliationDecision = z.infer<typeof ReconciliationDecisionSchema>;

/**
 * Use LLM to decide how a new candidate relates to existing similar memories.
 * Returns a structured decision: add, supersede, merge, or skip.
 */
export async function reconcileCandidate(
  candidate: MemoryCandidate,
  similarMemories: SimilarMemory[],
  config: ReconciliationConfig,
): Promise<ReconciliationDecision> {
  // If no similar memories exist, always ADD without LLM call
  if (similarMemories.length === 0) {
    return {
      action: 'add',
      reason: 'No similar existing memories found',
      existing_memory_id: null,
      merged_content: null,
    };
  }

  const model = createClaudeModel(config.model ?? DEFAULT_MODEL, config.claude);

  const candidateStr = JSON.stringify(
    {
      content: candidate.content,
      type: candidate.type,
      source_type: candidate.source_type,
      confidence: candidate.confidence,
      validity_start: candidate.validity_start,
      validity_end: candidate.validity_end,
      tags: candidate.tags,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
    },
    null,
    2,
  );

  const existingStr = JSON.stringify(
    similarMemories.map((sm) => ({
      id: sm.memory.id,
      content: sm.memory.content,
      type: sm.memory.type,
      source_type: sm.memory.source_type,
      confidence: sm.memory.confidence,
      status: sm.memory.status,
      similarity_score: sm.score,
      validity_start: sm.memory.validity_start,
      validity_end: sm.memory.validity_end,
      created_at: sm.memory.created_at,
    })),
    null,
    2,
  );

  const prompt = RECONCILIATION_PROMPT.replace('{candidate}', candidateStr).replace(
    '{existing_memories}',
    existingStr,
  );

  const { output } = await generateText({
    model,
    output: Output.object({ schema: ReconciliationDecisionSchema }),
    prompt,
    maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
  });

  return output;
}
