import type { Memory, Scope } from '@deeprecall/types';

/**
 * Authorization rule for mutating or inspecting a memory by id.
 *
 * The caller passes iff:
 *   1. For every scope key K the caller provided:
 *      memory[K] === caller[K] OR memory[K] === null   (no contradictions), AND
 *   2. At least one scope key K exists where:
 *      memory[K] === caller[K] AND memory[K] !== null  (positive identification).
 *
 * Non-contradiction alone is NOT enough — that would let callers inspect
 * memories scoped to a different principal (e.g., agent-only memories by
 * claiming a user_id that isn't on the memory).
 */
export function authorizeScope(
  memory: Pick<Memory, 'user_id' | 'agent_id'>,
  caller: Pick<Scope, 'user_id' | 'agent_id'>,
): boolean {
  let positiveMatches = 0;
  let callerKeys = 0;

  if (caller.user_id !== undefined) {
    callerKeys++;
    if (memory.user_id === null) {
      // no contradiction, but no positive match either
    } else if (memory.user_id === caller.user_id) {
      positiveMatches++;
    } else {
      return false; // contradicts memory.user_id
    }
  }

  if (caller.agent_id !== undefined) {
    callerKeys++;
    if (memory.agent_id === null) {
      // no contradiction, but no positive match either
    } else if (memory.agent_id === caller.agent_id) {
      positiveMatches++;
    } else {
      return false; // contradicts memory.agent_id
    }
  }

  // Caller must have provided at least one scope key, and at least one
  // of those keys must positively match a non-null field on the memory.
  return callerKeys > 0 && positiveMatches > 0;
}
