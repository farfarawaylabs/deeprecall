import { generateText } from 'ai';
import { CLAUDE_MAX_OUTPUT_TOKENS, createClaudeModel, type ClaudeConfig } from './claude';
import type { Memory } from '@deeprecall/types';

const DEFAULT_MODEL = 'claude-sonnet-5';

const PROFILE_PROMPT = `You are a memory consolidation system. Given a set of individual fact memories about a user, synthesize them into a single, coherent user profile summary.

Rules:
- Combine related facts into natural paragraphs
- Resolve any contradictions by preferring the most recent or highest-confidence fact
- Do not invent information — only include what is supported by the provided facts
- Keep the profile concise but comprehensive
- Use third-person perspective (e.g., "The user prefers...")
- Group related information together (preferences, work, personal, etc.)

Facts:
{facts}

Write a consolidated profile summary:`;

/** Configuration for the profile-consolidation LLM call. */
export interface ProfileConsolidationConfig {
  /** Claude runtime (provider selection + credentials). */
  claude: ClaudeConfig;
  /** Model to use (defaults to claude-sonnet-5). */
  model?: string;
}

/**
 * Synthesize a set of fact memories into a consolidated profile summary.
 */
export async function consolidateProfile(
  facts: Memory[],
  config: ProfileConsolidationConfig,
): Promise<string> {
  const model = createClaudeModel(config.model ?? DEFAULT_MODEL, config.claude);

  const factsText = facts
    .map(
      (f, i) =>
        `${i + 1}. [confidence: ${f.confidence}, source: ${f.source_type}, updated: ${f.updated_at}] ${f.content}`,
    )
    .join('\n');

  const prompt = PROFILE_PROMPT.replace('{facts}', factsText);

  const result = await generateText({
    model,
    prompt,
    maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
  });

  return result.text;
}
