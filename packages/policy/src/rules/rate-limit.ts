import type { MemoryCandidate } from '@deeprecall/types';
import type { PolicyContext, PolicyRule, RuleResult } from '../types';

const DEFAULT_MAX_MEMORIES_PER_HOUR = 100;

export function createRateLimitRule(maxMemoriesPerHour?: number): PolicyRule {
  const limit = maxMemoriesPerHour ?? DEFAULT_MAX_MEMORIES_PER_HOUR;

  return {
    name: 'rate_limit',
    description: `Max ${limit} memories per user per hour to prevent runaway extraction`,
    evaluate(_candidate: MemoryCandidate, context: PolicyContext): RuleResult {
      if (context.memories_created_this_period >= limit) {
        return {
          passed: false,
          reason: `Rate limit exceeded: ${context.memories_created_this_period} memories created this hour (limit: ${limit})`,
        };
      }

      return { passed: true };
    },
  };
}
