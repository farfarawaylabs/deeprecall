import type { MemoryCandidate } from '@deeprecall/types';
import type {
  CandidateVerdict,
  PolicyContext,
  PolicyEngineResult,
  PolicyOverrides,
  PolicyRule,
} from './types';
import { createPiiDetectionRule } from './rules/pii-detection';
import { createConfidenceThresholdRule } from './rules/confidence-threshold';
import { createRateLimitRule } from './rules/rate-limit';

/** Build the default rule set, applying any product-specific overrides. */
function buildRules(overrides?: PolicyOverrides): PolicyRule[] {
  return [
    createPiiDetectionRule(overrides?.additional_pii_patterns),
    createConfidenceThresholdRule(overrides?.min_agent_confidence),
    createRateLimitRule(overrides?.max_memories_per_hour),
  ];
}

/** Apply mutations from a passing rule to the candidate (immutable). */
function applyMutations(
  candidate: MemoryCandidate,
  mutations: Partial<MemoryCandidate>,
): MemoryCandidate {
  return { ...candidate, ...mutations };
}

/**
 * Evaluate a single candidate against all rules.
 * Rules run in order. The first rejection stops evaluation.
 * Passing rules may mutate the candidate.
 */
function evaluateCandidate(
  candidate: MemoryCandidate,
  rules: PolicyRule[],
  context: PolicyContext,
): CandidateVerdict {
  let current = candidate;
  const results: CandidateVerdict['results'] = [];

  for (const rule of rules) {
    const result = rule.evaluate(current, context);
    results.push({ rule: rule.name, result });

    if (!result.passed) {
      return {
        candidate: current,
        approved: false,
        results,
        rejection_reason: result.reason,
      };
    }

    // Apply any mutations from passing rules
    if (result.mutations) {
      current = applyMutations(current, result.mutations);
    }
  }

  return {
    candidate: current,
    approved: true,
    results,
  };
}

/**
 * Run the policy engine on a batch of candidates.
 * Pure function — no I/O, no async, no side effects.
 */
export function runPolicyEngine(
  candidates: MemoryCandidate[],
  context: PolicyContext,
  overrides?: PolicyOverrides,
): PolicyEngineResult {
  const allRules = buildRules(overrides);

  // Filter out disabled rules
  const rules = overrides?.disabled_rules?.length
    ? allRules.filter((r) => !overrides.disabled_rules!.includes(r.name))
    : allRules;

  const verdicts: CandidateVerdict[] = [];
  const approved: MemoryCandidate[] = [];
  const rejected: PolicyEngineResult['rejected'] = [];

  for (const candidate of candidates) {
    const verdict = evaluateCandidate(candidate, rules, context);
    verdicts.push(verdict);

    if (verdict.approved) {
      approved.push(verdict.candidate);
    } else {
      rejected.push({
        candidate,
        reason: verdict.rejection_reason ?? 'Unknown policy violation',
      });
    }
  }

  return { approved, rejected, verdicts };
}
