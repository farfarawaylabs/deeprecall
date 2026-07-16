import { describe, it, expect } from 'vitest';
import { authorizeScope } from '../../src/auth/scope-check';

// Truth table for the authorization match rule (docs/ARCHITECTURE.md, "Scoping Within a Product"):
//   M = memory, C = caller.
//   Pass iff no contradictions AND at least one positive non-null match.
describe('authorizeScope', () => {
  it('user match passes when memory has both user_id and agent_id', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { user_id: 'U' })).toBe(true);
  });

  it('agent match passes when memory has both user_id and agent_id', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { agent_id: 'A' })).toBe(true);
  });

  it('both keys match passes', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { user_id: 'U', agent_id: 'A' })).toBe(
      true,
    );
  });

  it('contradicting user_id fails', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { user_id: 'V' })).toBe(false);
  });

  it('caller claims agent_id but memory has no agent_id — no positive match, fails', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: null }, { agent_id: 'A' })).toBe(false);
  });

  it('caller claims user_id but memory has no user_id — no positive match, fails', () => {
    expect(authorizeScope({ user_id: null, agent_id: 'A' }, { user_id: 'U' })).toBe(false);
  });

  it('both provided, user matches, agent null on memory — passes', () => {
    // Caller gives both; user_id matches, memory.agent_id is null so no
    // contradiction. Positive match on user_id satisfies the positive rule.
    expect(authorizeScope({ user_id: 'U', agent_id: null }, { user_id: 'U', agent_id: 'A' })).toBe(
      true,
    );
  });

  it('both provided, agent matches, user null on memory — passes', () => {
    expect(authorizeScope({ user_id: null, agent_id: 'A' }, { user_id: 'U', agent_id: 'A' })).toBe(
      true,
    );
  });

  it('both provided with mismatch on one — fails (contradiction)', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { user_id: 'U', agent_id: 'B' })).toBe(
      false,
    );
  });

  it('no caller keys provided — fails', () => {
    expect(authorizeScope({ user_id: 'U', agent_id: null }, {})).toBe(false);
  });

  it("caller user_id matches but memory also has a non-matching agent_id that caller didn't claim — passes", () => {
    // Caller only provides user_id. Memory has agent_id "A" which caller
    // doesn't claim. That's not a contradiction — caller simply isn't
    // asserting anything about agent_id.
    expect(authorizeScope({ user_id: 'U', agent_id: 'A' }, { user_id: 'U' })).toBe(true);
  });
});
