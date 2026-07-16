import type { SceneType } from '@deeprecall/types';
import type { IngestionPayload, ParseResult } from '../types';

/** Classify scene type from content and source channel. */
function classifyScene(content: string, source_channel: string, hint?: SceneType): SceneType {
  if (hint) return hint;

  switch (source_channel) {
    case 'document':
      return 'document';
    case 'api':
      return 'api_direct';
    case 'chat':
    default:
      // Simple heuristic: if content has multiple speakers, it's a conversation
      return 'one_on_one_chat';
  }
}

/** Step 1: Parse input, classify scene type, load extraction template from KV. */
export async function parseAndClassify(
  payload: IngestionPayload,
  kv: KVNamespace,
): Promise<ParseResult> {
  const scene_type = classifyScene(payload.content, payload.source_channel, payload.scene_type);

  // Try to load a product-specific template, fall back to default
  const templateKey = `template:${payload.product_id}:${scene_type}`;
  const defaultTemplateKey = `template:default:${scene_type}`;
  const extraction_template = (await kv.get(templateKey)) ?? (await kv.get(defaultTemplateKey));

  return {
    content: payload.content,
    product_id: payload.product_id,
    scope: payload.scope,
    source_channel: payload.source_channel,
    scene_type,
    extraction_template,
    occurred_at: payload.occurred_at ?? null,
    trace_id: payload.trace_id,
  };
}
