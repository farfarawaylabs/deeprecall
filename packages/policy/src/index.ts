// Engine
export { runPolicyEngine } from './engine';

// Types
export type {
  PolicyContext,
  PolicyOverrides,
  PolicyEngineResult,
  CandidateVerdict,
  PolicyRule,
  RuleResult,
} from './types';

// Individual rule factories (for testing or custom composition)
export { createPiiDetectionRule } from './rules/pii-detection';
export { createConfidenceThresholdRule } from './rules/confidence-threshold';
export { createRateLimitRule } from './rules/rate-limit';
