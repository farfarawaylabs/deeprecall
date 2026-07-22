import { generateText, Output } from 'ai';
import { z } from 'zod';
import { MemoryCandidate } from '@deeprecall/types';
import type { ExtractionConfig } from './types';
import { CLAUDE_MAX_OUTPUT_TOKENS, createClaudeModel } from './claude';
import { CHAT_EXTRACTION_TEMPLATE } from './prompts/chat-extraction';

const DEFAULT_MODEL = 'claude-sonnet-5';

const ExtractionResult = z.object({
  memories: z.array(MemoryCandidate),
});

/** Get the prompt template for a given scene type. */
function getTemplate(sceneType: string, customTemplate?: string): string {
  if (customTemplate) return customTemplate;

  switch (sceneType) {
    case 'one_on_one_chat':
    case 'group_chat':
      return CHAT_EXTRACTION_TEMPLATE;
    case 'document':
    case 'api_direct':
    case 'system_event':
      // No dedicated template for these scene types yet — the chat
      // template extracts well for them, so it serves as the default.
      return CHAT_EXTRACTION_TEMPLATE;
    default:
      return CHAT_EXTRACTION_TEMPLATE;
  }
}

/**
 * Extract structured memory candidates from content using LLM.
 * Uses Vercel AI SDK structured output on the configured Claude runtime
 * (Anthropic API or Bedrock — see claude.ts).
 */
export async function extractMemories(
  content: string,
  config: ExtractionConfig,
): Promise<MemoryCandidate[]> {
  const model = createClaudeModel(config.model ?? DEFAULT_MODEL, config.claude);
  const template = getTemplate(config.sceneType, config.template);
  const referenceTime =
    config.referenceTime ??
    'not provided — anchor to dates stated inside the conversation itself ' +
      '(e.g. a "[Conversation on ...]" header)';
  // Replacer functions so "$"-patterns in values are inserted literally, and
  // {reference_time} first so untrusted content can't inject into it.
  const prompt = template
    .replace('{reference_time}', () => referenceTime)
    .replace('{content}', () => content);

  const { output } = await generateText({
    model,
    output: Output.object({ schema: ExtractionResult }),
    prompt,
    maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
  });

  return output.memories;
}
