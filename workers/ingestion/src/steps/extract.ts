import { extractMemories, type ClaudeConfig } from '@deeprecall/ai';
import type { MemoryCandidate } from '@deeprecall/types';
import type { ParseResult } from '../types';

/** Step 2: Extract memory candidates from content using LLM. */
export async function extract(
  parseResult: ParseResult,
  claude: ClaudeConfig,
): Promise<MemoryCandidate[]> {
  const candidates = await extractMemories(parseResult.content, {
    claude,
    sceneType: parseResult.scene_type,
    template: parseResult.extraction_template ?? undefined,
    referenceTime: parseResult.occurred_at ?? undefined,
  });

  return candidates;
}
