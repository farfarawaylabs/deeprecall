import { describe, it, expect } from 'vitest';
import type { MemoryCandidate } from '@deeprecall/types';
import {
  runPolicyEngine,
  createPiiDetectionRule,
  createConfidenceThresholdRule,
  createRateLimitRule,
} from '../index';
import type { PolicyContext } from '../types';

/** Helper to create a minimal valid candidate. */
function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    content: 'User prefers dark mode',
    episode: null,
    type: 'fact',
    source_actor: 'user',
    source_type: 'user_stated',
    confidence: 0.9,
    validity_start: null,
    validity_end: null,
    tags: [],
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

/** Helper to create a default policy context. */
function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    product_id: 'default',
    user_id: 'user-1',
    memories_created_this_period: 0,
    ...overrides,
  };
}

// ─── PII Detection ───────────────────────────────────────────────

describe('PII Detection Rule', () => {
  const rule = createPiiDetectionRule();
  const ctx = makeContext();

  it('passes clean content', () => {
    const candidate = makeCandidate({ content: 'User likes TypeScript' });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('rejects SSN patterns', () => {
    const candidate = makeCandidate({
      content: 'My SSN is 123-45-6789',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('SSN');
  });

  it('rejects SSN with spaces', () => {
    const candidate = makeCandidate({
      content: 'SSN 123 45 6789 on file',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
  });

  it('does not false-positive on plain 9-digit numbers', () => {
    const candidate = makeCandidate({
      content: 'Order number 123456789 confirmed',
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('rejects credit card numbers', () => {
    const candidate = makeCandidate({
      content: 'Card number 4111-1111-1111-1111',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('credit_card');
  });

  it('rejects API keys (OpenAI format)', () => {
    const candidate = makeCandidate({
      content: 'My key is sk-abc123def456ghi789jkl012mno345',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('api_key');
  });

  it('rejects AWS access keys', () => {
    const candidate = makeCandidate({
      content: 'AWS key: AKIAIOSFODNN7EXAMPLE',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('api_key');
  });

  it('rejects GitHub personal access tokens', () => {
    const candidate = makeCandidate({
      content: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('api_key');
  });

  it('rejects password patterns', () => {
    const candidate = makeCandidate({
      content: 'password=SuperSecret123!',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('password_pattern');
  });

  it('rejects private key headers', () => {
    const candidate = makeCandidate({
      content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBA...',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('private_key');
  });

  it('checks episode field for PII', () => {
    const candidate = makeCandidate({
      content: 'User discussed finances',
      episode: 'Shared card number 4111-1111-1111-1111 during chat',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
  });

  it('checks subject/object fields for PII', () => {
    const candidate = makeCandidate({
      content: 'User has a key',
      subject: 'sk-abc123def456ghi789jkl012mno345',
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
  });

  it('supports additional custom patterns', () => {
    const customRule = createPiiDetectionRule(['\\bMRN-\\d{6}\\b']);
    const candidate = makeCandidate({
      content: 'Medical record MRN-123456',
    });
    const result = customRule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('custom_pii');
  });

  it('ignores invalid custom patterns gracefully', () => {
    const customRule = createPiiDetectionRule(['[invalid regex']);
    const candidate = makeCandidate({ content: 'Normal text' });
    // Should not throw; invalid pattern is silently dropped
    expect(customRule.evaluate(candidate, ctx).passed).toBe(true);
  });
});

// ─── Confidence Threshold ────────────────────────────────────────

describe('Confidence Threshold Rule', () => {
  const rule = createConfidenceThresholdRule();
  const ctx = makeContext();

  it('passes user-stated facts at any confidence', () => {
    const candidate = makeCandidate({
      source_type: 'user_stated',
      confidence: 0.1,
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('passes agent-inferred at or above threshold', () => {
    const candidate = makeCandidate({
      source_type: 'agent_inferred',
      confidence: 0.7,
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('passes agent-inferred above threshold', () => {
    const candidate = makeCandidate({
      source_type: 'agent_inferred',
      confidence: 0.95,
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('rejects agent-inferred below threshold', () => {
    const candidate = makeCandidate({
      source_type: 'agent_inferred',
      confidence: 0.5,
    });
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('0.5');
    expect(result.reason).toContain('0.7');
  });

  it('passes system_imported at any confidence', () => {
    const candidate = makeCandidate({
      source_type: 'system_imported',
      confidence: 0.3,
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('passes document_extracted at any confidence', () => {
    const candidate = makeCandidate({
      source_type: 'document_extracted',
      confidence: 0.4,
    });
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('respects custom threshold override', () => {
    const strictRule = createConfidenceThresholdRule(0.9);
    const candidate = makeCandidate({
      source_type: 'agent_inferred',
      confidence: 0.8,
    });
    expect(strictRule.evaluate(candidate, ctx).passed).toBe(false);
  });
});

// ─── Rate Limit ──────────────────────────────────────────────────

describe('Rate Limit Rule', () => {
  const rule = createRateLimitRule();

  it('passes when under limit', () => {
    const ctx = makeContext({ memories_created_this_period: 50 });
    const candidate = makeCandidate();
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('passes at limit - 1', () => {
    const ctx = makeContext({ memories_created_this_period: 99 });
    const candidate = makeCandidate();
    expect(rule.evaluate(candidate, ctx).passed).toBe(true);
  });

  it('rejects at limit', () => {
    const ctx = makeContext({ memories_created_this_period: 100 });
    const candidate = makeCandidate();
    const result = rule.evaluate(candidate, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
  });

  it('rejects above limit', () => {
    const ctx = makeContext({ memories_created_this_period: 150 });
    const candidate = makeCandidate();
    expect(rule.evaluate(candidate, ctx).passed).toBe(false);
  });

  it('respects custom limit override', () => {
    const strictRule = createRateLimitRule(10);
    const ctx = makeContext({ memories_created_this_period: 10 });
    const candidate = makeCandidate();
    expect(strictRule.evaluate(candidate, ctx).passed).toBe(false);
  });

  it('applies equally to agent-only scope', () => {
    // Agent-only scope: user_id undefined, agent_id set.
    // Caller counts by agent_id and passes via memories_created_this_period.
    const agentCtx: PolicyContext = {
      product_id: 'default',
      agent_id: 'agent-only-1',
      memories_created_this_period: 100,
    };
    const candidate = makeCandidate();
    expect(rule.evaluate(candidate, agentCtx).passed).toBe(false);

    const underCtx: PolicyContext = {
      ...agentCtx,
      memories_created_this_period: 50,
    };
    expect(rule.evaluate(candidate, underCtx).passed).toBe(true);
  });
});

// ─── Full Engine ─────────────────────────────────────────────────

describe('Policy Engine (runPolicyEngine)', () => {
  const ctx = makeContext();

  it('approves clean candidates', () => {
    const candidates = [
      makeCandidate({ content: 'User likes dark mode' }),
      makeCandidate({ content: 'User works at Acme Corp' }),
    ];
    const result = runPolicyEngine(candidates, ctx);
    expect(result.approved).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects PII and keeps clean candidates', () => {
    const candidates = [
      makeCandidate({ content: 'User likes dark mode' }),
      makeCandidate({ content: 'SSN is 123-45-6789' }),
      makeCandidate({ content: 'User uses VS Code' }),
    ];
    const result = runPolicyEngine(candidates, ctx);
    expect(result.approved).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('PII');
  });

  it('rejects low-confidence agent-inferred memories', () => {
    const candidates = [
      makeCandidate({
        content: 'User might prefer Python',
        source_type: 'agent_inferred',
        confidence: 0.3,
      }),
    ];
    const result = runPolicyEngine(candidates, ctx);
    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('confidence');
  });

  it('enforces rate limits', () => {
    const heavyCtx = makeContext({ memories_created_this_period: 100 });
    const candidates = [makeCandidate()];
    const result = runPolicyEngine(candidates, heavyCtx);
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('Rate limit');
  });

  it('respects policy overrides', () => {
    const candidates = [
      makeCandidate({
        source_type: 'agent_inferred',
        confidence: 0.5,
      }),
    ];
    // Default threshold (0.7) rejects this
    expect(runPolicyEngine(candidates, ctx).approved).toHaveLength(0);

    // Custom threshold (0.4) allows it
    const result = runPolicyEngine(candidates, ctx, {
      min_agent_confidence: 0.4,
    });
    expect(result.approved).toHaveLength(1);
  });

  it('allows disabling rules via overrides', () => {
    const candidates = [makeCandidate({ content: 'SSN is 123-45-6789' })];
    // Normally rejected
    expect(runPolicyEngine(candidates, ctx).approved).toHaveLength(0);

    // Disable PII rule
    const result = runPolicyEngine(candidates, ctx, {
      disabled_rules: ['pii_detection'],
    });
    expect(result.approved).toHaveLength(1);
  });

  it('provides detailed verdicts', () => {
    const candidates = [makeCandidate({ content: 'User likes TypeScript' })];
    const result = runPolicyEngine(candidates, ctx);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].approved).toBe(true);
    expect(result.verdicts[0].results.length).toBeGreaterThan(0);
    // All default rules should have been evaluated
    expect(result.verdicts[0].results.map((r) => r.rule)).toContain('pii_detection');
    expect(result.verdicts[0].results.map((r) => r.rule)).toContain('confidence_threshold');
  });

  it('stops at first failing rule', () => {
    const candidates = [
      makeCandidate({
        content: 'SSN is 123-45-6789',
        source_type: 'agent_inferred',
        confidence: 0.3,
      }),
    ];
    const result = runPolicyEngine(candidates, ctx);
    expect(result.rejected).toHaveLength(1);
    // PII runs first and rejects; confidence threshold never runs
    expect(result.rejected[0].reason).toContain('PII');
    const verdict = result.verdicts[0];
    expect(verdict.results).toHaveLength(1);
    expect(verdict.results[0].rule).toBe('pii_detection');
  });
});
