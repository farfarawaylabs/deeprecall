import { describe, it, expect } from 'vitest';
import { buildVectorizeFilters } from '../filters';

describe('buildVectorizeFilters', () => {
  it('user-only scope produces one filter', () => {
    const filters = buildVectorizeFilters({ user_id: 'U' }, { status: 'active' });
    expect(filters).toEqual([{ user_id: 'U', status: 'active' }]);
  });

  it('agent-only scope produces one filter', () => {
    const filters = buildVectorizeFilters({ agent_id: 'A' }, { status: 'active' });
    expect(filters).toEqual([{ agent_id: 'A', status: 'active' }]);
  });

  it('both scope keys produces two filters (one per key)', () => {
    const filters = buildVectorizeFilters({ user_id: 'U', agent_id: 'A' }, { status: 'active' });
    expect(filters).toHaveLength(2);
    expect(filters).toContainEqual({ user_id: 'U', status: 'active' });
    expect(filters).toContainEqual({ agent_id: 'A', status: 'active' });
    // Critically: neither filter mixes both keys — Vectorize can't OR
    // across metadata keys, so we fan out.
    for (const f of filters) {
      expect(!!f.user_id && !!f.agent_id).toBe(false);
    }
  });

  it('omits extras when not provided', () => {
    const filters = buildVectorizeFilters({ user_id: 'U' });
    expect(filters).toEqual([{ user_id: 'U' }]);
  });

  it('throws when scope is empty', () => {
    expect(() => buildVectorizeFilters({} as { user_id?: string })).toThrow(
      /at least one of user_id or agent_id/,
    );
  });
});
