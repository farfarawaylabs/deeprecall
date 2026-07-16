import type { Memory, MemoryStatus, SourceType } from '@deeprecall/types';
import type {
  IMemoryRepository,
  MemoryCreateInput,
  MemoryListFilters,
  PaginationParams,
  PaginatedResult,
  ScopeKeys,
} from '../interfaces';
import { D1_MAX_BOUND_PARAMS } from '../constants';

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Wraps each word in double quotes to treat them as literals,
 * preventing FTS5 operator injection (*, OR, AND, NOT, NEAR, etc.).
 */
function sanitizeFts5Query(query: string): string {
  // Remove double quotes to prevent injection, split into words, quote each term
  const terms = query
    .replace(/"/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"`).join(' ');
}

/** Parse a raw D1 row into a typed Memory object. */
function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    content: row.content as string,
    episode: (row.episode as string) ?? null,
    type: row.type as Memory['type'],
    status: row.status as Memory['status'],
    user_id: (row.user_id as string) ?? null,
    agent_id: (row.agent_id as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    source_actor: row.source_actor as string,
    source_type: row.source_type as Memory['source_type'],
    source_channel: (row.source_channel as Memory['source_channel']) ?? null,
    confidence: row.confidence as number,
    document_id: (row.document_id as string) ?? null,
    validity_start: (row.validity_start as string) ?? null,
    validity_end: (row.validity_end as string) ?? null,
    observed_at: row.observed_at as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    superseded_by: (row.superseded_by as string) ?? null,
    tags: row.tags ? JSON.parse(row.tags as string) : null,
    subject: (row.subject as string) ?? null,
    predicate: (row.predicate as string) ?? null,
    object: (row.object as string) ?? null,
  };
}

/**
 * Relaxed scope WHERE builder.
 * For each provided key K: memory[K] = ? OR memory[K] IS NULL.
 * "Null on memory applies to everyone on that dimension."
 * Returns SQL fragments and bindings. Requires at least one key.
 */
function buildRelaxedScopeWhere(
  scope: ScopeKeys,
  column: { user_id: string; agent_id: string } = {
    user_id: 'user_id',
    agent_id: 'agent_id',
  },
): { conditions: string[]; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (scope.user_id) {
    conditions.push(`(${column.user_id} = ? OR ${column.user_id} IS NULL)`);
    bindings.push(scope.user_id);
  }
  if (scope.agent_id) {
    conditions.push(`(${column.agent_id} = ? OR ${column.agent_id} IS NULL)`);
    bindings.push(scope.agent_id);
  }
  if (conditions.length === 0) {
    throw new Error('Scope must include at least one of user_id or agent_id');
  }
  return { conditions, bindings };
}

/**
 * Strict scope WHERE builder.
 * For each provided key K: memory[K] = ? (null on memory does NOT match).
 * Used by destructive ops and rate-limit counts.
 */
function buildStrictScopeWhere(
  scope: ScopeKeys,
  column: { user_id: string; agent_id: string } = {
    user_id: 'user_id',
    agent_id: 'agent_id',
  },
): { conditions: string[]; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (scope.user_id) {
    conditions.push(`${column.user_id} = ?`);
    bindings.push(scope.user_id);
  }
  if (scope.agent_id) {
    conditions.push(`${column.agent_id} = ?`);
    bindings.push(scope.agent_id);
  }
  if (conditions.length === 0) {
    throw new Error('Scope must include at least one of user_id or agent_id');
  }
  return { conditions, bindings };
}

export class D1MemoryRepository implements IMemoryRepository {
  constructor(private db: D1Database) {}

  async create(input: MemoryCreateInput): Promise<Memory> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO memories (
        id, content, episode, type, status,
        user_id, agent_id, session_id,
        source_actor, source_type, source_channel, confidence,
        document_id, validity_start, validity_end,
        observed_at, created_at, updated_at,
        tags, subject, predicate, object
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )`,
    );

    await stmt
      .bind(
        input.id,
        input.content,
        input.episode,
        input.type,
        input.status,
        input.user_id,
        input.agent_id,
        input.session_id,
        input.source_actor,
        input.source_type,
        input.source_channel,
        input.confidence,
        input.document_id,
        input.validity_start,
        input.validity_end,
        input.observed_at,
        now,
        now,
        input.tags ? JSON.stringify(input.tags) : null,
        input.subject,
        input.predicate,
        input.object,
      )
      .run();

    const memory = await this.getById(input.id);
    if (!memory) throw new Error(`Failed to create memory ${input.id}`);
    return memory;
  }

  async getById(id: string): Promise<Memory | null> {
    const result = await this.db.prepare('SELECT * FROM memories WHERE id = ?').bind(id).first();

    if (!result) return null;
    return rowToMemory(result);
  }

  async getByIds(ids: string[]): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
      const chunk = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all();
      memories.push(...results.map(rowToMemory));
    }
    return memories;
  }

  async listByScope(
    filters: MemoryListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Memory>> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // Scope is optional here. When both keys are absent the result is a
    // product-wide list — useful for sync/ETL clients pulling everything
    // ingested since a timestamp. When either key is present, relaxed
    // matching applies (null on the row passes).
    if (filters.user_id || filters.agent_id) {
      const scope = buildRelaxedScopeWhere({
        user_id: filters.user_id,
        agent_id: filters.agent_id,
      });
      conditions.push(...scope.conditions);
      bindings.push(...scope.bindings);
    }

    if (filters.status) {
      conditions.push('status = ?');
      bindings.push(filters.status);
    }
    if (filters.type) {
      conditions.push('type = ?');
      bindings.push(filters.type);
    }
    if (filters.since) {
      conditions.push('created_at >= ?');
      bindings.push(filters.since);
    }
    if (pagination.cursor) {
      // Composite cursor: "created_at|id" for stable pagination
      const [cursorTime, cursorId] = pagination.cursor.split('|');
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      bindings.push(cursorTime, cursorTime, cursorId);
    }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
    // Fetch one extra to determine if there's a next page
    const limit = pagination.limit + 1;
    bindings.push(limit);

    const { results } = await this.db
      .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...bindings)
      .all();

    const hasMore = results.length > pagination.limit;
    const items = results.slice(0, pagination.limit).map(rowToMemory);
    const lastItem = items[items.length - 1];
    const cursor = hasMore && lastItem ? `${lastItem.created_at}|${lastItem.id}` : null;

    return { items, cursor };
  }

  async updateStatus(id: string, status: MemoryStatus, superseded_by?: string): Promise<void> {
    const now = new Date().toISOString();
    if (superseded_by) {
      await this.db
        .prepare('UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?')
        .bind(status, superseded_by, now, id)
        .run();
    } else {
      await this.db
        .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, now, id)
        .run();
    }
  }

  async search(query: string, scope: ScopeKeys, limit: number): Promise<Memory[]> {
    // Sanitize FTS5 query: escape special characters and wrap each term in quotes
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    // Relaxed scope match on the outer SELECT (fts only matches content).
    const scopeWhere = buildRelaxedScopeWhere(scope, {
      user_id: 'm.user_id',
      agent_id: 'm.agent_id',
    });
    const whereClauses = ['memories_fts MATCH ?', ...scopeWhere.conditions, "m.status = 'active'"];
    const where = whereClauses.join(' AND ');

    const { results } = await this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE ${where}
         ORDER BY rank
         LIMIT ?`,
      )
      .bind(sanitized, ...scopeWhere.bindings, limit)
      .all();

    return results.map(rowToMemory);
  }

  async deleteByScope(scope: ScopeKeys): Promise<number> {
    const { conditions, bindings } = buildStrictScopeWhere(scope);
    const where = conditions.join(' AND ');
    const result = await this.db
      .prepare(`DELETE FROM memories WHERE ${where}`)
      .bind(...bindings)
      .run();

    return result.meta.changes ?? 0;
  }

  async updateConfidenceAndSourceType(
    id: string,
    confidence: number,
    source_type: SourceType,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare('UPDATE memories SET confidence = ?, source_type = ?, updated_at = ? WHERE id = ?')
      .bind(confidence, source_type, now, id)
      .run();
  }

  async countCreatedSince(scope: ScopeKeys, since: string): Promise<number> {
    const { conditions, bindings } = buildStrictScopeWhere(scope);
    const where = [...conditions, 'created_at >= ?'].join(' AND ');
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM memories WHERE ${where}`)
      .bind(...bindings, since)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }

  async findStaleMemories(notUpdatedSince: string, limit: number): Promise<Memory[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memories
         WHERE status = 'active'
           AND source_type != 'user_stated'
           AND updated_at < ?
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(notUpdatedSince, limit)
      .all();

    return results.map(rowToMemory);
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare('UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?')
      .bind(confidence, now, id)
      .run();
  }

  async findFactsForProfile(
    scope: ScopeKeys,
    minConfidence: number,
    limit: number,
  ): Promise<Memory[]> {
    // Disjoint-pool rule:
    //   user run  ({ user_id }):  WHERE user_id = ?
    //   agent run ({ agent_id }): WHERE agent_id = ? AND user_id IS NULL
    //   both:                     treat as user run (user roll-up)
    let where: string;
    let bindings: unknown[];

    if (scope.user_id) {
      where = 'user_id = ?';
      bindings = [scope.user_id];
    } else if (scope.agent_id) {
      where = 'agent_id = ? AND user_id IS NULL';
      bindings = [scope.agent_id];
    } else {
      throw new Error('Scope must include at least one of user_id or agent_id');
    }

    const { results } = await this.db
      .prepare(
        `SELECT * FROM memories
         WHERE ${where} AND status = 'active' AND type = 'fact'
           AND confidence >= ?
         ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      )
      .bind(...bindings, minConfidence, limit)
      .all();

    return results.map(rowToMemory);
  }

  async getActiveUserIds(limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT user_id FROM memories
         WHERE status = 'active' AND user_id IS NOT NULL
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ user_id: string }>();

    return results.map((r) => r.user_id);
  }

  async getActiveAgentIds(limit: number): Promise<string[]> {
    // Standalone-agent pool only: agent_id set AND user_id IS NULL.
    // Memories that have both user_id and agent_id roll up under the user,
    // not the agent (disjoint profile pools).
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT agent_id FROM memories
         WHERE status = 'active'
           AND agent_id IS NOT NULL
           AND user_id IS NULL
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ agent_id: string }>();

    return results.map((r) => r.agent_id);
  }

  async listIdsByScopeStrict(scope: ScopeKeys, limit: number): Promise<string[]> {
    const { conditions, bindings } = buildStrictScopeWhere(scope);
    const where = conditions.join(' AND ');
    const { results } = await this.db
      .prepare(`SELECT id FROM memories WHERE ${where} LIMIT ?`)
      .bind(...bindings, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async listAllIds(limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM memories LIMIT ?')
      .bind(limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async deleteAll(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM memories').run();
    return result.meta.changes ?? 0;
  }

  async listIdsByDocumentId(documentId: string, limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM memories WHERE document_id = ? LIMIT ?')
      .bind(documentId, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async deleteByDocumentId(documentId: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM memories WHERE document_id = ?')
      .bind(documentId)
      .run();
    return result.meta.changes ?? 0;
  }

  async listIdsWithAnyDocument(limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM memories WHERE document_id IS NOT NULL LIMIT ?')
      .bind(limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async deleteAllWithDocument(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM memories WHERE document_id IS NOT NULL')
      .run();
    return result.meta.changes ?? 0;
  }
}
