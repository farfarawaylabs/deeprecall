import { describe, it, expect, vi } from 'vitest';
import { parseAndClassify } from '../../src/steps/parse-classify';
import type { IngestionPayload } from '../../src/types';

function makePayload(overrides: Partial<IngestionPayload> = {}): IngestionPayload {
  return {
    content: 'User: I love TypeScript',
    product_id: 'default',
    scope: { user_id: 'user-1' },
    source_channel: 'chat',
    trace_id: 'trace-123',
    ...overrides,
  };
}

function makeMockKV(entries: Record<string, string> = {}) {
  return {
    get: vi.fn((key: string) => Promise.resolve(entries[key] ?? null)),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('parseAndClassify', () => {
  it('classifies chat source_channel as one_on_one_chat', async () => {
    const result = await parseAndClassify(makePayload(), makeMockKV());
    expect(result.scene_type).toBe('one_on_one_chat');
  });

  it('classifies document source_channel as document', async () => {
    const result = await parseAndClassify(
      makePayload({ source_channel: 'document' }),
      makeMockKV(),
    );
    expect(result.scene_type).toBe('document');
  });

  it('classifies api source_channel as api_direct', async () => {
    const result = await parseAndClassify(makePayload({ source_channel: 'api' }), makeMockKV());
    expect(result.scene_type).toBe('api_direct');
  });

  it('uses scene_type hint when provided', async () => {
    const result = await parseAndClassify(makePayload({ scene_type: 'group_chat' }), makeMockKV());
    expect(result.scene_type).toBe('group_chat');
  });

  it('loads product-specific template from KV', async () => {
    const kv = makeMockKV({
      'template:default:one_on_one_chat': 'Extract from: {content}',
    });

    const result = await parseAndClassify(makePayload(), kv);
    expect(result.extraction_template).toBe('Extract from: {content}');
    expect(kv.get).toHaveBeenCalledWith('template:default:one_on_one_chat');
  });

  it('falls back to default template when product-specific not found', async () => {
    const kv = makeMockKV({
      'template:default:one_on_one_chat': 'Default template',
    });

    // Use a non-"default" product so the product-specific key differs from the default key
    const result = await parseAndClassify(makePayload({ product_id: 'custom-product' }), kv);
    expect(result.extraction_template).toBe('Default template');
    // Verify it tried product-specific first, then fell back to default
    expect(kv.get).toHaveBeenCalledWith('template:custom-product:one_on_one_chat');
    expect(kv.get).toHaveBeenCalledWith('template:default:one_on_one_chat');
  });

  it('returns null extraction_template when no template exists', async () => {
    const result = await parseAndClassify(makePayload(), makeMockKV());
    expect(result.extraction_template).toBeNull();
  });

  it('preserves payload content and scope', async () => {
    const result = await parseAndClassify(makePayload(), makeMockKV());
    expect(result.content).toBe('User: I love TypeScript');
    expect(result.product_id).toBe('default');
    expect(result.scope.user_id).toBe('user-1');
    expect(result.trace_id).toBe('trace-123');
  });

  it('passes occurred_at through to the parse result', async () => {
    const result = await parseAndClassify(
      makePayload({ occurred_at: '2023-05-08T13:56:00Z' }),
      makeMockKV(),
    );
    expect(result.occurred_at).toBe('2023-05-08T13:56:00Z');
  });

  it('defaults occurred_at to null when not provided', async () => {
    const result = await parseAndClassify(makePayload(), makeMockKV());
    expect(result.occurred_at).toBeNull();
  });
});
