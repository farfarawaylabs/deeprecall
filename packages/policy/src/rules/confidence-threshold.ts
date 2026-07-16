import type { MemoryCandidate } from '@deeprecall/types';
import type { PolicyContext, PolicyRule, RuleResult } from '../types';

const DEFAULT_MIN_AGENT_CONFIDENCE = 0.7;

export function createConfidenceThresholdRule(minAgentConfidence?: number): PolicyRule {
  const threshold = minAgentConfidence ?? DEFAULT_MIN_AGENT_CONFIDENCE;

  return {
    name: 'confidence_threshold',
    description: `Agent-inferred memories require confidence >= ${threshold}. User-stated memories pass at any confidence.`,
    evaluate(candidate: MemoryCandidate, _context: PolicyContext): RuleResult {
      // User-stated facts always pass regardless of confidence
      if (candidate.source_type === 'user_stated') {
        return { passed: true };
      }

      // Agent-inferred memories must meet the threshold
      if (candidate.source_type === 'agent_inferred' && candidate.confidence < threshold) {
        return {
          passed: false,
          reason: `Agent-inferred memory confidence ${candidate.confidence} is below threshold ${threshold}`,
        };
      }

      return { passed: true };
    },
  };
}
