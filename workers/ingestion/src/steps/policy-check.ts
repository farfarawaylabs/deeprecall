import { runPolicyEngine, type PolicyContext, type PolicyOverrides } from '@deeprecall/policy';
import type { EmbeddedCandidate, PolicyResult } from '../types';

/**
 * Step 4: Policy Check.
 * Runs all candidates through the deterministic policy engine.
 * Filters PII, enforces confidence thresholds, and checks rate
 * limits. Returns approved and rejected splits.
 */
export function policyCheck(
  candidates: EmbeddedCandidate[],
  context: PolicyContext,
  overrides?: PolicyOverrides,
): PolicyResult {
  const engineResult = runPolicyEngine(
    candidates.map((ec) => ec.candidate),
    context,
    overrides,
  );

  // Verdicts are in the same order as input candidates.
  // Use them to pair back with embeddings and pick up any mutations.
  const approved: EmbeddedCandidate[] = [];
  for (let i = 0; i < engineResult.verdicts.length; i++) {
    const verdict = engineResult.verdicts[i];
    if (verdict.approved) {
      approved.push({
        candidate: verdict.candidate,
        embedding: candidates[i].embedding,
      });
    }
  }

  return {
    approved,
    rejected: engineResult.rejected,
  };
}
