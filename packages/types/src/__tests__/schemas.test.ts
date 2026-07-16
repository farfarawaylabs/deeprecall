import { describe, it, expect } from 'vitest';
import {
  Memory,
  MemoryCandidate,
  IngestionRequest,
  QueryRequest,
  Scope,
  ApiError,
  MemoryType,
  MemoryStatus,
  SourceType,
  SourceChannel,
  SceneType,
} from '../index';

describe('Scope', () => {
  it('accepts user-only scope', () => {
    const result = Scope.safeParse({ user_id: 'user-123' });
    expect(result.success).toBe(true);
  });

  it('accepts agent-only scope', () => {
    const result = Scope.safeParse({ agent_id: 'agent-1' });
    expect(result.success).toBe(true);
  });

  it('accepts both user and agent', () => {
    const result = Scope.safeParse({
      user_id: 'user-123',
      agent_id: 'agent-1',
      session_id: 'sess-abc',
    });
    expect(result.success).toBe(true);
  });

  it('rejects scope with neither user_id nor agent_id', () => {
    const result = Scope.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects session-only scope', () => {
    const result = Scope.safeParse({ session_id: 'sess-abc' });
    expect(result.success).toBe(false);
  });

  it('silently drops product_id (unknown keys stripped)', () => {
    const result = Scope.safeParse({
      product_id: 'should-be-stripped',
      user_id: 'user-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).product_id).toBeUndefined();
    }
  });

  it('rejects empty user_id', () => {
    const result = Scope.safeParse({ user_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty agent_id', () => {
    const result = Scope.safeParse({ agent_id: '' });
    expect(result.success).toBe(false);
  });
});

describe('MemoryCandidate', () => {
  it('accepts valid candidate', () => {
    const result = MemoryCandidate.safeParse({
      content: 'User prefers dark mode',
      episode: null,
      type: 'fact',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 0.95,
      validity_start: null,
      validity_end: null,
      tags: ['preference', 'ui'],
      subject: 'user',
      predicate: 'prefers',
      object: 'dark mode',
    });
    expect(result.success).toBe(true);
  });

  it('rejects candidate with confidence > 1', () => {
    const result = MemoryCandidate.safeParse({
      content: 'test',
      episode: null,
      type: 'fact',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 1.5,
      validity_start: null,
      validity_end: null,
      tags: [],
      subject: null,
      predicate: null,
      object: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects candidate with invalid type', () => {
    const result = MemoryCandidate.safeParse({
      content: 'test',
      episode: null,
      type: 'invalid_type',
      source_actor: 'user',
      source_type: 'user_stated',
      confidence: 0.5,
      validity_start: null,
      validity_end: null,
      tags: [],
      subject: null,
      predicate: null,
      object: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('IngestionRequest', () => {
  it('accepts valid ingest request', () => {
    const result = IngestionRequest.safeParse({
      content: 'I prefer using TypeScript over JavaScript.',
      scope: { user_id: 'user-123' },
      source_channel: 'chat',
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent-only scope', () => {
    const result = IngestionRequest.safeParse({
      content: 'Agent-only knowledge',
      scope: { agent_id: 'agent-1' },
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for source_channel', () => {
    const result = IngestionRequest.safeParse({
      content: 'Some content',
      scope: { user_id: 'user-123' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source_channel).toBe('chat');
    }
  });

  it('rejects empty content', () => {
    const result = IngestionRequest.safeParse({
      content: '',
      scope: { user_id: 'user-123' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing scope', () => {
    const result = IngestionRequest.safeParse({
      content: 'Some content',
    });
    expect(result.success).toBe(false);
  });
});

describe('QueryRequest', () => {
  it('accepts valid query', () => {
    const result = QueryRequest.safeParse({
      query: "What are the user's preferences?",
      scope: { user_id: 'user-123' },
      mode: 'recall',
      top_k: 5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent-only query', () => {
    const result = QueryRequest.safeParse({
      query: 'What does the agent know?',
      scope: { agent_id: 'agent-1' },
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for mode and top_k', () => {
    const result = QueryRequest.safeParse({
      query: 'What does the user like?',
      scope: { user_id: 'user-123' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('recall');
      expect(result.data.top_k).toBe(30);
    }
  });

  it('rejects top_k > 50', () => {
    const result = QueryRequest.safeParse({
      query: 'test',
      scope: { user_id: 'user-123' },
      top_k: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty query', () => {
    const result = QueryRequest.safeParse({
      query: '',
      scope: { user_id: 'user-123' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Memory', () => {
  const validMemory = {
    id: 'mem-123',
    content: 'User prefers dark mode',
    episode: null,
    type: 'fact' as const,
    status: 'active' as const,
    user_id: 'user-123',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated' as const,
    source_channel: 'chat' as const,
    confidence: 0.95,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: '2026-04-13T00:00:00Z',
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
    superseded_by: null,
    tags: ['preference'],
    subject: null,
    predicate: null,
    object: null,
  };

  it('accepts valid memory', () => {
    const result = Memory.safeParse(validMemory);
    expect(result.success).toBe(true);
  });

  it('rejects memory with invalid status', () => {
    const result = Memory.safeParse({
      ...validMemory,
      status: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects memory missing required content', () => {
    const { content: _content, ...noContent } = validMemory;
    const result = Memory.safeParse(noContent);
    expect(result.success).toBe(false);
  });
});

describe('ApiError', () => {
  it('accepts valid error', () => {
    const result = ApiError.safeParse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: { field: 'content' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts error without details', () => {
    const result = ApiError.safeParse({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid error code', () => {
    const result = ApiError.safeParse({
      error: {
        code: 'UNKNOWN_CODE',
        message: 'test',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Enums', () => {
  it('validates MemoryType values', () => {
    expect(MemoryType.safeParse('fact').success).toBe(true);
    expect(MemoryType.safeParse('episode').success).toBe(true);
    expect(MemoryType.safeParse('foresight').success).toBe(true);
    expect(MemoryType.safeParse('profile').success).toBe(true);
    expect(MemoryType.safeParse('invalid').success).toBe(false);
  });

  it('validates MemoryStatus values', () => {
    expect(MemoryStatus.safeParse('active').success).toBe(true);
    expect(MemoryStatus.safeParse('superseded').success).toBe(true);
    expect(MemoryStatus.safeParse('invalid').success).toBe(false);
  });

  it('validates SourceType values', () => {
    expect(SourceType.safeParse('user_stated').success).toBe(true);
    expect(SourceType.safeParse('agent_inferred').success).toBe(true);
    expect(SourceType.safeParse('invalid').success).toBe(false);
  });

  it('validates SourceChannel values', () => {
    expect(SourceChannel.safeParse('chat').success).toBe(true);
    expect(SourceChannel.safeParse('document').success).toBe(true);
    expect(SourceChannel.safeParse('invalid').success).toBe(false);
  });

  it('validates SceneType values', () => {
    expect(SceneType.safeParse('one_on_one_chat').success).toBe(true);
    expect(SceneType.safeParse('document').success).toBe(true);
    expect(SceneType.safeParse('invalid').success).toBe(false);
  });
});
