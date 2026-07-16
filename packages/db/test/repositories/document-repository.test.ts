import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { D1DocumentRepository } from '../../src/repositories/document-repository';
import type { DocumentCreateInput } from '../../src/interfaces';

function makeInput(overrides: Partial<DocumentCreateInput> = {}): DocumentCreateInput {
  return {
    id: crypto.randomUUID(),
    r2_key: `default/documents/${crypto.randomUUID()}.pdf`,
    filename: 'report.pdf',
    mime_type: 'application/pdf',
    size_bytes: 12345,
    file_type: 'pdf',
    document_type: 'research_doc',
    description: 'Test research document',
    user_id: 'user-doc-test',
    agent_id: null,
    session_id: null,
    metadata: null,
    ...overrides,
  };
}

describe('D1DocumentRepository', () => {
  let repo: D1DocumentRepository;

  beforeEach(() => {
    repo = new D1DocumentRepository(env.DB);
  });

  describe('create', () => {
    it('creates and returns a document', async () => {
      const input = makeInput();
      const doc = await repo.create(input);

      expect(doc.id).toBe(input.id);
      expect(doc.r2_key).toBe(input.r2_key);
      expect(doc.filename).toBe('report.pdf');
      expect(doc.mime_type).toBe('application/pdf');
      expect(doc.size_bytes).toBe(12345);
      expect(doc.file_type).toBe('pdf');
      expect(doc.document_type).toBe('research_doc');
      expect(doc.description).toBe('Test research document');
      expect(doc.user_id).toBe('user-doc-test');
      expect(doc.agent_id).toBeNull();
      expect(doc.session_id).toBeNull();
      expect(doc.uploaded_at).toBeDefined();
    });

    it('persists the full scope triple', async () => {
      const input = makeInput({
        user_id: 'u1',
        agent_id: 'a1',
        session_id: 's1',
      });
      const doc = await repo.create(input);
      expect(doc.user_id).toBe('u1');
      expect(doc.agent_id).toBe('a1');
      expect(doc.session_id).toBe('s1');
    });

    it('persists an agent-only scope with user_id null', async () => {
      const input = makeInput({
        user_id: null,
        agent_id: 'agent-shared',
        session_id: null,
      });
      const doc = await repo.create(input);
      expect(doc.user_id).toBeNull();
      expect(doc.agent_id).toBe('agent-shared');
    });

    it('stores and parses JSON metadata', async () => {
      const input = makeInput({
        metadata: { pages: 42, language: 'en' },
      });
      const doc = await repo.create(input);

      expect(doc.metadata).toEqual({ pages: 42, language: 'en' });
    });

    it('handles null optional fields', async () => {
      const input = makeInput({
        filename: null,
        mime_type: null,
        size_bytes: null,
        file_type: null,
        document_type: null,
        description: null,
        user_id: null,
        agent_id: 'agent-x',
        session_id: null,
        metadata: null,
      });
      const doc = await repo.create(input);

      expect(doc.filename).toBeNull();
      expect(doc.mime_type).toBeNull();
      expect(doc.size_bytes).toBeNull();
      expect(doc.file_type).toBeNull();
      expect(doc.document_type).toBeNull();
      expect(doc.description).toBeNull();
      expect(doc.metadata).toBeNull();
    });

    it('accepts any free-form string for document_type', async () => {
      const input = makeInput({ document_type: 'knowledge_file' });
      const doc = await repo.create(input);
      expect(doc.document_type).toBe('knowledge_file');
    });
  });

  describe('getById', () => {
    it('returns null for non-existent document', async () => {
      const result = await repo.getById('non-existent');
      expect(result).toBeNull();
    });

    it('returns the document by id', async () => {
      const input = makeInput();
      await repo.create(input);

      const found = await repo.getById(input.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(input.id);
    });
  });

  describe('deleteById', () => {
    it('deletes a document', async () => {
      const input = makeInput();
      await repo.create(input);

      await repo.deleteById(input.id);
      const found = await repo.getById(input.id);
      expect(found).toBeNull();
    });
  });

  describe('list', () => {
    it('filters by user_id with relaxed match (null user_id on row passes)', async () => {
      const user = `u-${crypto.randomUUID()}`;
      const other = `u-${crypto.randomUUID()}`;
      const agent = `agent-${crypto.randomUUID()}`;

      const mine = await repo.create(makeInput({ user_id: user }));
      const agentOnly = await repo.create(makeInput({ user_id: null, agent_id: agent }));
      await repo.create(makeInput({ user_id: other }));

      const page = await repo.list({ user_id: user }, { limit: 10 });
      const ids = page.items.map((d) => d.id).sort();
      // Relaxed: mine + the agent-only row (user_id IS NULL) both pass.
      expect(ids).toEqual([mine.id, agentOnly.id].sort());
    });

    it('filters by agent_id with relaxed match', async () => {
      const agent = `agent-${crypto.randomUUID()}`;
      const other = `agent-${crypto.randomUUID()}`;

      const a = await repo.create(makeInput({ user_id: null, agent_id: agent }));
      await repo.create(makeInput({ user_id: null, agent_id: other }));
      // Agent=null on row → relaxed match passes.
      const userOnly = await repo.create(
        makeInput({ user_id: `u-${crypto.randomUUID()}`, agent_id: null }),
      );

      const page = await repo.list({ agent_id: agent }, { limit: 10 });
      const ids = page.items.map((d) => d.id).sort();
      expect(ids).toEqual([a.id, userOnly.id].sort());
    });

    it('filters by session_id with relaxed match', async () => {
      const session = `s-${crypto.randomUUID()}`;
      const sessioned = await repo.create(
        makeInput({
          user_id: `u-${crypto.randomUUID()}`,
          session_id: session,
        }),
      );
      const sessionless = await repo.create(
        makeInput({
          user_id: `u-${crypto.randomUUID()}`,
          session_id: null,
        }),
      );

      const page = await repo.list({ session_id: session }, { limit: 10 });
      const ids = page.items.map((d) => d.id).sort();
      // Relaxed: both the sessioned and sessionless rows pass.
      expect(ids).toContain(sessioned.id);
      expect(ids).toContain(sessionless.id);
    });

    it('returns everything when no scope filter is provided', async () => {
      await repo.deleteAll();
      await repo.create(makeInput());
      await repo.create(makeInput({ user_id: null, agent_id: 'a' }));
      await repo.create(makeInput({ user_id: null, agent_id: null, session_id: 's' }));

      const page = await repo.list({}, { limit: 10 });
      expect(page.items.length).toBe(3);
    });

    it('filters by document_type', async () => {
      const user = `user-${crypto.randomUUID()}`;
      const report = await repo.create(makeInput({ user_id: user, document_type: 'report' }));
      await repo.create(makeInput({ user_id: user, document_type: 'transcript' }));

      const page = await repo.list({ user_id: user, document_type: 'report' }, { limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe(report.id);
    });

    it('filters by file_type', async () => {
      const user = `user-${crypto.randomUUID()}`;
      const pdf = await repo.create(makeInput({ user_id: user, file_type: 'pdf' }));
      await repo.create(makeInput({ user_id: user, file_type: 'markdown' }));
      await repo.create(makeInput({ user_id: user, file_type: 'text' }));

      const page = await repo.list({ user_id: user, file_type: 'pdf' }, { limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe(pdf.id);
    });

    it('paginates via cursor', async () => {
      const user = `user-cursor-${crypto.randomUUID()}`;
      for (let i = 0; i < 5; i++) {
        await repo.create(makeInput({ user_id: user }));
      }

      const first = await repo.list({ user_id: user }, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.cursor).not.toBeNull();

      const second = await repo.list({ user_id: user }, { limit: 2, cursor: first.cursor! });
      expect(second.items).toHaveLength(2);

      const third = await repo.list({ user_id: user }, { limit: 2, cursor: second.cursor! });
      expect(third.items.length).toBeGreaterThanOrEqual(1);

      const all = [...first.items, ...second.items, ...third.items].map((d) => d.id);
      // No ID repeats across pages.
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe('update', () => {
    it('updates provided fields and leaves others untouched', async () => {
      const doc = await repo.create(makeInput({ description: 'old desc' }));

      const updated = await repo.update(doc.id, {
        filename: 'new.pdf',
        description: 'new desc',
      });

      expect(updated.filename).toBe('new.pdf');
      expect(updated.description).toBe('new desc');
      // Fields not in the update stay the same.
      expect(updated.mime_type).toBe(doc.mime_type);
      expect(updated.size_bytes).toBe(doc.size_bytes);
      expect(updated.document_type).toBe(doc.document_type);
      expect(updated.user_id).toBe(doc.user_id);
      expect(updated.agent_id).toBe(doc.agent_id);
      expect(updated.session_id).toBe(doc.session_id);
    });

    it('allows reassigning scope atomically', async () => {
      const doc = await repo.create(makeInput({ user_id: 'u1', agent_id: null, session_id: null }));
      const updated = await repo.update(doc.id, {
        user_id: null,
        agent_id: 'a1',
        session_id: 's1',
      });
      expect(updated.user_id).toBeNull();
      expect(updated.agent_id).toBe('a1');
      expect(updated.session_id).toBe('s1');
    });

    it('allows clearing nullable fields by passing null', async () => {
      const doc = await repo.create(makeInput({ description: 'orig' }));
      const updated = await repo.update(doc.id, { description: null });
      expect(updated.description).toBeNull();
    });

    it('updates metadata as JSON', async () => {
      const doc = await repo.create(makeInput({ metadata: { v: 1 } }));
      const updated = await repo.update(doc.id, { metadata: { v: 2 } });
      expect(updated.metadata).toEqual({ v: 2 });
    });

    it('throws when document does not exist', async () => {
      await expect(repo.update('no-such-doc', { description: 'x' })).rejects.toThrow(/not found/);
    });
  });

  describe('listCleanupRefsByScope', () => {
    it('returns only id + r2_key for rows strictly matching the scope', async () => {
      const user = `cleanup-${crypto.randomUUID()}`;
      const d = await repo.create(makeInput({ user_id: user }));
      await repo.create(makeInput({ user_id: `other-${crypto.randomUUID()}` }));
      // Strict: agent-only row with user_id=NULL must NOT match a user-scoped purge.
      await repo.create(makeInput({ user_id: null, agent_id: `a-${crypto.randomUUID()}` }));

      const refs = await repo.listCleanupRefsByScope({ user_id: user }, 10);
      expect(refs).toEqual([{ id: d.id, r2_key: d.r2_key }]);
    });
  });

  describe('deleteByScope', () => {
    it('deletes only strictly-matching rows and returns count', async () => {
      const user = `del-user-${crypto.randomUUID()}`;
      const survivor = await repo.create(makeInput({ user_id: `keep-${crypto.randomUUID()}` }));
      const agentSurvivor = await repo.create(
        makeInput({ user_id: null, agent_id: `a-${crypto.randomUUID()}` }),
      );
      await repo.create(makeInput({ user_id: user }));
      await repo.create(makeInput({ user_id: user }));

      const count = await repo.deleteByScope({ user_id: user });
      expect(count).toBe(2);
      expect(await repo.getById(survivor.id)).not.toBeNull();
      // Strict scope: agent-only row with NULL user_id is NOT swept up.
      expect(await repo.getById(agentSurvivor.id)).not.toBeNull();
    });

    it('deletes rows matching a combined user+agent scope', async () => {
      const user = `u-${crypto.randomUUID()}`;
      const agent = `a-${crypto.randomUUID()}`;
      await repo.create(makeInput({ user_id: user, agent_id: agent }));
      await repo.create(makeInput({ user_id: user, agent_id: agent }));
      // Same user but different agent — should NOT be deleted.
      const otherAgent = await repo.create(
        makeInput({ user_id: user, agent_id: `different-${crypto.randomUUID()}` }),
      );

      const count = await repo.deleteByScope({
        user_id: user,
        agent_id: agent,
      });
      expect(count).toBe(2);
      expect(await repo.getById(otherAgent.id)).not.toBeNull();
    });
  });

  describe('deleteAll', () => {
    it('deletes every document row', async () => {
      await repo.create(makeInput({ user_id: `a-${crypto.randomUUID()}` }));
      await repo.create(makeInput({ user_id: `b-${crypto.randomUUID()}` }));

      const count = await repo.deleteAll();
      expect(count).toBeGreaterThanOrEqual(2);

      // Subsequent list call returns nothing.
      const page = await repo.list({}, { limit: 10 });
      expect(page.items).toHaveLength(0);
    });
  });
});
