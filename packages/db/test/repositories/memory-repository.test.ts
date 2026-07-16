import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { D1MemoryRepository } from '../../src/repositories/memory-repository';
import type { MemoryCreateInput } from '../../src/interfaces';

function makeInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    id: crypto.randomUUID(),
    content: 'User likes TypeScript',
    episode: null,
    type: 'fact',
    status: 'active',
    user_id: 'user-1',
    agent_id: null,
    session_id: null,
    source_actor: 'user',
    source_type: 'user_stated',
    source_channel: 'chat',
    confidence: 0.9,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: new Date().toISOString(),
    tags: null,
    subject: null,
    predicate: null,
    object: null,
    ...overrides,
  };
}

describe('D1MemoryRepository', () => {
  let repo: D1MemoryRepository;

  beforeEach(() => {
    repo = new D1MemoryRepository(env.DB);
  });

  // ── create & getById ──────────────────────────────────────

  describe('create', () => {
    it('creates and returns a memory', async () => {
      const input = makeInput();
      const memory = await repo.create(input);

      expect(memory.id).toBe(input.id);
      expect(memory.content).toBe('User likes TypeScript');
      expect(memory.type).toBe('fact');
      expect(memory.status).toBe('active');
      expect(memory.user_id).toBe('user-1');
      expect(memory.source_type).toBe('user_stated');
      expect(memory.confidence).toBe(0.9);
      expect(memory.created_at).toBeDefined();
      expect(memory.updated_at).toBeDefined();
    });

    it('stores and parses JSON tags', async () => {
      const input = makeInput({ tags: ['preference', 'language'] });
      const memory = await repo.create(input);

      expect(memory.tags).toEqual(['preference', 'language']);
    });

    it('stores episode field', async () => {
      const input = makeInput({ episode: 'User mentioned they enjoy TypeScript' });
      const memory = await repo.create(input);

      expect(memory.episode).toBe('User mentioned they enjoy TypeScript');
    });

    it('stores subject/predicate/object triples', async () => {
      const input = makeInput({
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
      });
      const memory = await repo.create(input);

      expect(memory.subject).toBe('user');
      expect(memory.predicate).toBe('prefers');
      expect(memory.object).toBe('TypeScript');
    });
  });

  // ── getById ───────────────────────────────────────────────

  describe('getById', () => {
    it('returns null for non-existent id', async () => {
      const result = await repo.getById('non-existent');
      expect(result).toBeNull();
    });

    it('returns the memory by id', async () => {
      const input = makeInput();
      await repo.create(input);

      const found = await repo.getById(input.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(input.id);
    });
  });

  // ── getByIds ──────────────────────────────────────────────

  describe('getByIds', () => {
    it('returns empty array for empty input', async () => {
      const result = await repo.getByIds([]);
      expect(result).toEqual([]);
    });

    it('returns matching memories', async () => {
      const a = await repo.create(makeInput({ content: 'Fact A' }));
      const b = await repo.create(makeInput({ content: 'Fact B' }));
      await repo.create(makeInput({ content: 'Fact C' }));

      const result = await repo.getByIds([a.id, b.id]);
      expect(result).toHaveLength(2);
      const ids = result.map((m) => m.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });
  });

  // ── listByScope ───────────────────────────────────────────

  describe('listByScope', () => {
    it('lists memories for a user', async () => {
      await repo.create(makeInput({ user_id: 'user-A', content: 'A1' }));
      await repo.create(makeInput({ user_id: 'user-A', content: 'A2' }));
      await repo.create(makeInput({ user_id: 'user-B', content: 'B1' }));

      const result = await repo.listByScope({ user_id: 'user-A' }, { limit: 10 });
      expect(result.items).toHaveLength(2);
      expect(result.items.every((m) => m.user_id === 'user-A')).toBe(true);
    });

    it('filters by status', async () => {
      await repo.create(makeInput({ user_id: 'user-C', status: 'active' }));
      await repo.create(makeInput({ user_id: 'user-C', status: 'superseded' }));

      const result = await repo.listByScope({ user_id: 'user-C', status: 'active' }, { limit: 10 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe('active');
    });

    it('filters by type', async () => {
      await repo.create(makeInput({ user_id: 'user-D', type: 'fact' }));
      await repo.create(makeInput({ user_id: 'user-D', type: 'foresight' }));

      const result = await repo.listByScope(
        { user_id: 'user-D', type: 'foresight' },
        { limit: 10 },
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].type).toBe('foresight');
    });

    it('paginates with cursor', async () => {
      // Create 5 memories with slightly staggered timestamps
      for (let i = 0; i < 5; i++) {
        await repo.create(makeInput({ user_id: 'user-E', content: `Fact ${i}` }));
      }

      const page1 = await repo.listByScope({ user_id: 'user-E' }, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.cursor).not.toBeNull();

      const page2 = await repo.listByScope(
        { user_id: 'user-E' },
        { limit: 2, cursor: page1.cursor! },
      );
      expect(page2.items).toHaveLength(2);

      // Ensure no duplicates between pages
      const page1Ids = page1.items.map((m) => m.id);
      const page2Ids = page2.items.map((m) => m.id);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
    });

    it('returns null cursor when no more pages', async () => {
      await repo.create(makeInput({ user_id: 'user-F' }));

      const result = await repo.listByScope({ user_id: 'user-F' }, { limit: 10 });
      expect(result.cursor).toBeNull();
    });

    it('filters by `since` (created_at lower bound)', async () => {
      await repo.create(makeInput({ user_id: 'user-since', content: 'old' }));
      // create_at is generated on the JS side, so a slight delay makes the
      // boundary timestamp unambiguous without flake.
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      await repo.create(makeInput({ user_id: 'user-since', content: 'new-1' }));
      await repo.create(makeInput({ user_id: 'user-since', content: 'new-2' }));

      const result = await repo.listByScope(
        { user_id: 'user-since', since: cutoff },
        { limit: 10 },
      );
      expect(result.items).toHaveLength(2);
      expect(result.items.map((m) => m.content).sort()).toEqual(['new-1', 'new-2']);
    });

    it('lists product-wide when no scope keys are provided', async () => {
      await repo.create(makeInput({ user_id: 'user-wide-A' }));
      await repo.create(makeInput({ user_id: 'user-wide-B' }));
      await repo.create(makeInput({ user_id: null, agent_id: 'agent-wide' }));

      const result = await repo.listByScope({}, { limit: 100 });
      const ids = new Set(result.items.map((m) => m.user_id));
      expect(ids.has('user-wide-A')).toBe(true);
      expect(ids.has('user-wide-B')).toBe(true);
      expect(ids.has(null)).toBe(true);
    });

    it('paginates correctly when `since` is applied', async () => {
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      // Create 5 fresh memories under a dedicated user so other tests don't
      // pollute the count.
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const m = await repo.create(
          makeInput({ user_id: 'user-since-page', content: `since ${i}` }),
        );
        created.push(m.id);
      }

      const page1 = await repo.listByScope(
        { user_id: 'user-since-page', since: cutoff },
        { limit: 2 },
      );
      expect(page1.items).toHaveLength(2);
      expect(page1.cursor).not.toBeNull();

      const page2 = await repo.listByScope(
        { user_id: 'user-since-page', since: cutoff },
        { limit: 2, cursor: page1.cursor! },
      );
      expect(page2.items).toHaveLength(2);

      const page3 = await repo.listByScope(
        { user_id: 'user-since-page', since: cutoff },
        { limit: 2, cursor: page2.cursor! },
      );
      expect(page3.items).toHaveLength(1);
      expect(page3.cursor).toBeNull();

      const seen = new Set([
        ...page1.items.map((m) => m.id),
        ...page2.items.map((m) => m.id),
        ...page3.items.map((m) => m.id),
      ]);
      expect(seen.size).toBe(5);
      for (const id of created) expect(seen.has(id)).toBe(true);
    });

    it('combines `since` with product-wide listing', async () => {
      await repo.create(makeInput({ user_id: 'user-combo-old' }));
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      await repo.create(makeInput({ user_id: 'user-combo-newA' }));
      await repo.create(makeInput({ user_id: null, agent_id: 'agent-combo-new' }));

      const result = await repo.listByScope({ since: cutoff }, { limit: 100 });
      const userIds = result.items.map((m) => m.user_id);
      expect(userIds).toContain('user-combo-newA');
      expect(userIds).toContain(null);
      expect(userIds).not.toContain('user-combo-old');
    });
  });

  // ── updateStatus ──────────────────────────────────────────

  describe('updateStatus', () => {
    it('updates status', async () => {
      const memory = await repo.create(makeInput());
      await repo.updateStatus(memory.id, 'superseded');

      const updated = await repo.getById(memory.id);
      expect(updated!.status).toBe('superseded');
    });

    it('updates status with superseded_by', async () => {
      const old = await repo.create(makeInput({ content: 'Old fact' }));
      const newer = await repo.create(makeInput({ content: 'New fact' }));

      await repo.updateStatus(old.id, 'superseded', newer.id);

      const updated = await repo.getById(old.id);
      expect(updated!.status).toBe('superseded');
      expect(updated!.superseded_by).toBe(newer.id);
    });
  });

  // ── search (FTS5) ────────────────────────────────────────

  describe('search', () => {
    it('finds memories by keyword', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-search',
          content: 'User enjoys Python programming',
        }),
      );
      await repo.create(
        makeInput({
          user_id: 'user-search',
          content: 'User likes hiking in mountains',
        }),
      );

      const results = await repo.search('Python', { user_id: 'user-search' }, 10);
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('Python');
    });

    it('returns empty for empty query', async () => {
      const results = await repo.search('', { user_id: 'user-search' }, 10);
      expect(results).toEqual([]);
    });

    it('only returns active memories', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-search-2',
          content: 'Active fact about coding',
          status: 'active',
        }),
      );
      await repo.create(
        makeInput({
          user_id: 'user-search-2',
          content: 'Suppressed fact about coding',
          status: 'suppressed',
        }),
      );

      const results = await repo.search('coding', { user_id: 'user-search-2' }, 10);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('active');
    });

    it('sanitizes FTS5 special characters without crashing', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-search-3',
          content: 'User has a pet cat',
        }),
      );

      // Queries with FTS5 operators and special chars should not throw
      const results1 = await repo.search('pet* AND cat', { user_id: 'user-search-3' }, 10);
      expect(Array.isArray(results1)).toBe(true);

      // A query with just the matching term should work after sanitization
      const results2 = await repo.search('"cat"', { user_id: 'user-search-3' }, 10);
      expect(results2).toHaveLength(1);
      expect(results2[0].content).toContain('cat');
    });

    it('supports agent-only scope and relaxed match (null passes)', async () => {
      const agentId = `agent-search-${crypto.randomUUID()}`;
      // Agent-only memory (user_id null)
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: agentId,
          content: 'Agent knows about kubernetes',
        }),
      );
      // Shared agent memory (user_id set, agent_id set)
      await repo.create(
        makeInput({
          user_id: 'user-X',
          agent_id: agentId,
          content: 'User X asked about kubernetes',
        }),
      );

      const results = await repo.search('kubernetes', { agent_id: agentId }, 10);
      expect(results.length).toBe(2);
    });

    it('relaxed scope: null-on-memory passes for user-only query', async () => {
      const agentId = `agent-rlx-${crypto.randomUUID()}`;
      // Agent-only memory (user_id null)
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: agentId,
          content: 'Agent-only fact about docker',
        }),
      );
      // User memory that mentions docker
      await repo.create(
        makeInput({
          user_id: 'user-R',
          agent_id: null,
          content: 'User prefers docker',
        }),
      );

      // User-only search with agent_id unspecified: relaxed on agent_id
      // means agent-only memories (user_id null) ALSO pass, so both match.
      const results = await repo.search('docker', { user_id: 'user-R' }, 10);
      expect(results.length).toBe(2);
    });
  });

  // ── deleteByScope ─────────────────────────────────────────

  describe('deleteByScope', () => {
    it('deletes all memories for a user (strict match)', async () => {
      const userId = `user-delete-${crypto.randomUUID()}`;
      await repo.create(makeInput({ user_id: userId }));
      await repo.create(makeInput({ user_id: userId }));

      const count = await repo.deleteByScope({ user_id: userId });
      // D1 meta.changes may include FTS trigger operations, so count >= 2
      expect(count).toBeGreaterThanOrEqual(2);

      const remaining = await repo.listByScope({ user_id: userId }, { limit: 10 });
      expect(remaining.items).toHaveLength(0);
    });

    it('returns 0 when no memories to delete', async () => {
      const count = await repo.deleteByScope({
        user_id: `no-such-user-${crypto.randomUUID()}`,
      });
      expect(count).toBe(0);
    });

    it('strict match does NOT fall through null on memory', async () => {
      const agentId = `agent-del-${crypto.randomUUID()}`;
      // Agent-only memory (user_id null) — must NOT be deleted by a
      // user-scoped strict delete, since strict rules reject nulls.
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: agentId,
          content: 'Must survive user delete',
        }),
      );

      const count = await repo.deleteByScope({
        user_id: `no-such-user-${crypto.randomUUID()}`,
      });
      expect(count).toBe(0);

      // The agent-only memory should still be retrievable.
      const found = await repo.listByScope({ agent_id: agentId }, { limit: 10 });
      expect(found.items).toHaveLength(1);
    });

    it('deletes agent-only memories when scoped to agent_id', async () => {
      const agentId = `agent-del2-${crypto.randomUUID()}`;
      await repo.create(makeInput({ user_id: null, agent_id: agentId, content: 'A1' }));
      await repo.create(makeInput({ user_id: null, agent_id: agentId, content: 'A2' }));

      const count = await repo.deleteByScope({ agent_id: agentId });
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('throws when scope is empty', async () => {
      await expect(repo.deleteByScope({})).rejects.toThrow(/at least one of user_id or agent_id/);
    });
  });

  // ── countCreatedSince ─────────────────────────────────────

  describe('countCreatedSince', () => {
    it('counts memories created since a timestamp (strict)', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      await repo.create(makeInput({ user_id: 'user-count' }));
      await repo.create(makeInput({ user_id: 'user-count' }));

      const count = await repo.countCreatedSince({ user_id: 'user-count' }, past);
      expect(count).toBe(2);
    });

    it('returns 0 for future timestamp', async () => {
      await repo.create(makeInput({ user_id: 'user-count-2' }));

      const future = new Date(Date.now() + 3600_000).toISOString();
      const count = await repo.countCreatedSince({ user_id: 'user-count-2' }, future);
      expect(count).toBe(0);
    });

    it('counts agent-only memories when scoped by agent_id', async () => {
      const agentId = `agent-count-${crypto.randomUUID()}`;
      await repo.create(makeInput({ user_id: null, agent_id: agentId }));
      await repo.create(makeInput({ user_id: null, agent_id: agentId }));

      const past = new Date(Date.now() - 3600_000).toISOString();
      const count = await repo.countCreatedSince({ agent_id: agentId }, past);
      expect(count).toBe(2);
    });

    it('strict match: user-scoped count does NOT include null-user memories', async () => {
      const agentId = `agent-count-str-${crypto.randomUUID()}`;
      const userId = `user-count-str-${crypto.randomUUID()}`;
      await repo.create(makeInput({ user_id: null, agent_id: agentId }));
      await repo.create(makeInput({ user_id: userId }));

      const past = new Date(Date.now() - 3600_000).toISOString();
      const count = await repo.countCreatedSince({ user_id: userId }, past);
      expect(count).toBe(1);
    });
  });

  // ── updateConfidenceAndSourceType ─────────────────────────

  describe('updateConfidenceAndSourceType', () => {
    it('updates confidence and source_type', async () => {
      const memory = await repo.create(
        makeInput({
          confidence: 0.5,
          source_type: 'agent_inferred',
        }),
      );

      await repo.updateConfidenceAndSourceType(memory.id, 1.0, 'user_stated');

      const updated = await repo.getById(memory.id);
      expect(updated!.confidence).toBe(1.0);
      expect(updated!.source_type).toBe('user_stated');
    });
  });

  // ── findStaleMemories ─────────────────────────────────────

  describe('findStaleMemories', () => {
    it('finds memories not updated recently', async () => {
      // This memory will have updated_at = now, so won't be stale
      await repo.create(
        makeInput({
          user_id: 'user-stale',
          source_type: 'agent_inferred',
          content: 'Recent memory',
        }),
      );

      // The cutoff is in the future, so all memories are "stale"
      const future = new Date(Date.now() + 86400_000).toISOString();
      const stale = await repo.findStaleMemories(future, 100);
      const match = stale.filter((m) => m.user_id === 'user-stale');
      expect(match.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes user_stated memories from staleness', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-stale-2',
          source_type: 'user_stated',
          content: 'Pinned fact',
        }),
      );

      const future = new Date(Date.now() + 86400_000).toISOString();
      const stale = await repo.findStaleMemories(future, 100);
      const match = stale.filter((m) => m.user_id === 'user-stale-2');
      expect(match).toHaveLength(0);
    });
  });

  // ── updateConfidence ──────────────────────────────────────

  describe('updateConfidence', () => {
    it('updates confidence value', async () => {
      const memory = await repo.create(makeInput({ confidence: 0.8 }));
      await repo.updateConfidence(memory.id, 0.3);

      const updated = await repo.getById(memory.id);
      expect(updated!.confidence).toBe(0.3);
    });
  });

  // ── findFactsForProfile ───────────────────────────────────

  describe('findFactsForProfile', () => {
    it('finds active facts above confidence threshold', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-profile',
          type: 'fact',
          confidence: 0.9,
          content: 'High confidence fact',
        }),
      );
      await repo.create(
        makeInput({
          user_id: 'user-profile',
          type: 'fact',
          confidence: 0.3,
          content: 'Low confidence fact',
        }),
      );
      await repo.create(
        makeInput({
          user_id: 'user-profile',
          type: 'episode',
          confidence: 0.9,
          content: 'Episode not a fact',
        }),
      );

      const facts = await repo.findFactsForProfile({ user_id: 'user-profile' }, 0.5, 100);
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('High confidence fact');
    });

    it('orders by confidence descending', async () => {
      await repo.create(
        makeInput({
          user_id: 'user-profile-2',
          type: 'fact',
          confidence: 0.7,
        }),
      );
      await repo.create(
        makeInput({
          user_id: 'user-profile-2',
          type: 'fact',
          confidence: 0.95,
        }),
      );

      const facts = await repo.findFactsForProfile({ user_id: 'user-profile-2' }, 0.5, 100);
      expect(facts[0].confidence).toBe(0.95);
      expect(facts[1].confidence).toBe(0.7);
    });

    it('disjoint pools: user run does NOT pull agent-only memories', async () => {
      const userId = `user-disj-${crypto.randomUUID()}`;
      const agentId = `agent-disj-${crypto.randomUUID()}`;
      // Shared memory (both user and agent) — should appear for user run.
      await repo.create(
        makeInput({
          user_id: userId,
          agent_id: agentId,
          type: 'fact',
          confidence: 0.9,
          content: 'User+agent shared',
        }),
      );
      // Agent-only memory (user_id null) — must NOT appear for user run.
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: agentId,
          type: 'fact',
          confidence: 0.9,
          content: 'Agent-only',
        }),
      );

      const userFacts = await repo.findFactsForProfile({ user_id: userId }, 0.5, 100);
      expect(userFacts.map((f) => f.content)).toEqual(['User+agent shared']);
    });

    it('disjoint pools: agent run pulls only standalone-agent memories', async () => {
      const userId = `user-disj2-${crypto.randomUUID()}`;
      const agentId = `agent-disj2-${crypto.randomUUID()}`;
      // Shared memory — belongs to user pool, must NOT appear for agent run.
      await repo.create(
        makeInput({
          user_id: userId,
          agent_id: agentId,
          type: 'fact',
          confidence: 0.9,
          content: 'Under user',
        }),
      );
      // Standalone-agent memory — only these appear in agent run.
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: agentId,
          type: 'fact',
          confidence: 0.9,
          content: 'Standalone agent',
        }),
      );

      const agentFacts = await repo.findFactsForProfile({ agent_id: agentId }, 0.5, 100);
      expect(agentFacts.map((f) => f.content)).toEqual(['Standalone agent']);
    });

    it('throws when scope is empty', async () => {
      await expect(repo.findFactsForProfile({}, 0.5, 10)).rejects.toThrow(
        /at least one of user_id or agent_id/,
      );
    });
  });

  // ── getActiveUserIds ──────────────────────────────────────

  describe('getActiveUserIds', () => {
    it('returns distinct active user ids', async () => {
      await repo.create(makeInput({ user_id: 'uid-1' }));
      await repo.create(makeInput({ user_id: 'uid-1' }));
      await repo.create(makeInput({ user_id: 'uid-2' }));
      await repo.create(makeInput({ user_id: 'uid-3', status: 'archived' }));

      const userIds = await repo.getActiveUserIds(100);
      expect(userIds).toContain('uid-1');
      expect(userIds).toContain('uid-2');
      // uid-3 has no active memories
      expect(userIds).not.toContain('uid-3');
    });

    it('respects limit', async () => {
      await repo.create(makeInput({ user_id: 'lim-1' }));
      await repo.create(makeInput({ user_id: 'lim-2' }));
      await repo.create(makeInput({ user_id: 'lim-3' }));

      const userIds = await repo.getActiveUserIds(1);
      expect(userIds).toHaveLength(1);
    });
  });

  // ── getActiveAgentIds ─────────────────────────────────────

  describe('getActiveAgentIds', () => {
    it('returns only standalone-agent ids (user_id IS NULL)', async () => {
      const standaloneAgent = `agent-stand-${crypto.randomUUID()}`;
      const sharedAgent = `agent-shared-${crypto.randomUUID()}`;

      // Standalone-agent memory (must appear).
      await repo.create(
        makeInput({
          user_id: null,
          agent_id: standaloneAgent,
          content: 'standalone',
        }),
      );
      // Shared memory (user_id set) — must NOT appear.
      await repo.create(
        makeInput({
          user_id: 'someone',
          agent_id: sharedAgent,
          content: 'shared',
        }),
      );

      const agentIds = await repo.getActiveAgentIds(100);
      expect(agentIds).toContain(standaloneAgent);
      expect(agentIds).not.toContain(sharedAgent);
    });
  });

  // ── document cascade ──────────────────────────────────────

  describe('listIdsByDocumentId', () => {
    it('returns only IDs tied to the target document', async () => {
      const docA = crypto.randomUUID();
      const docB = crypto.randomUUID();

      const a1 = await repo.create(makeInput({ document_id: docA }));
      const a2 = await repo.create(makeInput({ document_id: docA }));
      await repo.create(makeInput({ document_id: docB }));
      await repo.create(makeInput({ document_id: null }));

      const ids = await repo.listIdsByDocumentId(docA, 100);
      expect(ids.sort()).toEqual([a1.id, a2.id].sort());
    });

    it('respects the limit argument', async () => {
      const doc = crypto.randomUUID();
      await repo.create(makeInput({ document_id: doc }));
      await repo.create(makeInput({ document_id: doc }));
      await repo.create(makeInput({ document_id: doc }));

      const ids = await repo.listIdsByDocumentId(doc, 2);
      expect(ids).toHaveLength(2);
    });
  });

  describe('deleteByDocumentId', () => {
    it('deletes only memories with the matching document_id', async () => {
      const docA = crypto.randomUUID();
      const docB = crypto.randomUUID();

      await repo.create(makeInput({ document_id: docA }));
      await repo.create(makeInput({ document_id: docA }));
      const survivor = await repo.create(makeInput({ document_id: docB }));
      const nullDoc = await repo.create(makeInput({ document_id: null }));

      const count = await repo.deleteByDocumentId(docA);
      // D1 meta.changes may include FTS trigger ops, so count >= 2
      expect(count).toBeGreaterThanOrEqual(2);

      expect(await repo.getById(survivor.id)).not.toBeNull();
      expect(await repo.getById(nullDoc.id)).not.toBeNull();
      expect(await repo.listIdsByDocumentId(docA, 100)).toEqual([]);
    });

    it('returns 0 when no matches exist', async () => {
      const count = await repo.deleteByDocumentId(crypto.randomUUID());
      expect(count).toBe(0);
    });
  });

  describe('listIdsWithAnyDocument', () => {
    it('returns memories with document_id set and excludes null ones', async () => {
      const doc = crypto.randomUUID();
      const withDoc = await repo.create(makeInput({ document_id: doc }));
      const withoutDoc = await repo.create(makeInput({ document_id: null }));

      const ids = await repo.listIdsWithAnyDocument(1000);
      expect(ids).toContain(withDoc.id);
      expect(ids).not.toContain(withoutDoc.id);
    });
  });
});
