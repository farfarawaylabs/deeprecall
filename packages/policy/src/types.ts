import type { MemoryCandidate } from '@deeprecall/types';

/** Context passed to every policy rule for evaluation. */
export interface PolicyContext {
  /** The product running this ingestion. */
  product_id: string;
  /** The user whose memories are being processed (if user-scoped). */
  user_id?: string;
  /** The agent whose memories are being processed (if agent-scoped). */
  agent_id?: string;
  /**
   * Number of memories already created for this scope in the current period.
   * The caller chooses which key to count by: user_id if present, else agent_id.
   * (When both are set, count by user_id — more restrictive principal that
   * prevents cross-agent flooding of a single user.)
   */
  memories_created_this_period: number;
}

/** Result of evaluating a single rule against a candidate. */
export interface RuleResult {
  /** Whether the candidate passed this rule. */
  passed: boolean;
  /** Human-readable reason if rejected. */
  reason?: string;
  /** Mutations to apply to the candidate if it passed. */
  mutations?: Partial<MemoryCandidate>;
}

/** A single deterministic policy rule. Pure function, no I/O. */
export interface PolicyRule {
  /** Unique identifier for this rule. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Evaluate the rule against a candidate. */
  evaluate(candidate: MemoryCandidate, context: PolicyContext): RuleResult;
}

/** Product-specific overrides loaded from KV. */
export interface PolicyOverrides {
  /** Minimum confidence for agent-inferred memories (default 0.7). */
  min_agent_confidence?: number;
  /** Max memories per scope per hour (default 100). */
  max_memories_per_hour?: number;
  /** Custom PII patterns to block (in addition to defaults). */
  additional_pii_patterns?: string[];
  /** Disable specific rules by name. */
  disabled_rules?: string[];
}

/** Outcome for a single candidate after all rules run. */
export interface CandidateVerdict {
  /** The (potentially mutated) candidate. */
  candidate: MemoryCandidate;
  /** Whether the candidate was approved. */
  approved: boolean;
  /** All rule results, including passes. */
  results: Array<{ rule: string; result: RuleResult }>;
  /** The rejection reason (first failing rule), if rejected. */
  rejection_reason?: string;
}

/** Aggregate result of running the policy engine on a batch. */
export interface PolicyEngineResult {
  approved: MemoryCandidate[];
  rejected: Array<{ candidate: MemoryCandidate; reason: string }>;
  verdicts: CandidateVerdict[];
}
