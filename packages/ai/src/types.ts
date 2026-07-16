import type { SceneType } from '@deeprecall/types';
import type { ClaudeConfig } from './claude';

/** Configuration for the memory-extraction LLM call (pipeline Step 2). */
export interface ExtractionConfig {
  /** Claude runtime (provider selection + credentials) */
  claude: ClaudeConfig;
  /** Model to use (defaults to claude-sonnet-5) */
  model?: string;
  /** Scene type for extraction prompt selection */
  sceneType: SceneType;
  /** Custom extraction template (overrides default for scene type) */
  template?: string;
  /** ISO timestamp of when the content originally occurred. Interpolated into
   * the {reference_time} template placeholder so the LLM anchors relative
   * dates against it instead of guessing. */
  referenceTime?: string;
}
