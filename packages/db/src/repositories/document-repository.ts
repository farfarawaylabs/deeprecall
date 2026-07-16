import type { Document } from '@deeprecall/types';
import type {
  IDocumentRepository,
  DocumentCreateInput,
  DocumentUpdateInput,
  DocumentListFilters,
  DocumentCleanupRef,
  PaginationParams,
  PaginatedResult,
  ScopeKeys,
} from '../interfaces';

/** Parse a raw D1 row into a typed Document object. */
function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: row.id as string,
    r2_key: row.r2_key as string,
    filename: (row.filename as string) ?? null,
    mime_type: (row.mime_type as string) ?? null,
    size_bytes: (row.size_bytes as number) ?? null,
    file_type: (row.file_type as Document['file_type']) ?? null,
    document_type: (row.document_type as string) ?? null,
    description: (row.description as string) ?? null,
    user_id: (row.user_id as string) ?? null,
    agent_id: (row.agent_id as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    uploaded_at: row.uploaded_at as string,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  };
}

/**
 * Strict scope WHERE builder — mirrors memory repo semantics. Null on the
 * row does NOT match. Requires at least one of user_id / agent_id. Used
 * by destructive ops (purge cleanup, delete by scope) so a scoped caller
 * can't accidentally sweep up null-scoped rows they don't own.
 */
function buildStrictScopeWhere(scope: ScopeKeys): {
  conditions: string[];
  bindings: unknown[];
} {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (scope.user_id) {
    conditions.push('user_id = ?');
    bindings.push(scope.user_id);
  }
  if (scope.agent_id) {
    conditions.push('agent_id = ?');
    bindings.push(scope.agent_id);
  }
  if (conditions.length === 0) {
    throw new Error('Scope must include at least one of user_id or agent_id');
  }
  return { conditions, bindings };
}

export class D1DocumentRepository implements IDocumentRepository {
  constructor(private db: D1Database) {}

  async create(input: DocumentCreateInput): Promise<Document> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO documents (
          id, r2_key, filename, mime_type, size_bytes,
          file_type, document_type, description,
          user_id, agent_id, session_id,
          uploaded_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.r2_key,
        input.filename,
        input.mime_type,
        input.size_bytes,
        input.file_type,
        input.document_type,
        input.description,
        input.user_id,
        input.agent_id,
        input.session_id,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
      )
      .run();

    const doc = await this.getById(input.id);
    if (!doc) throw new Error(`Failed to create document ${input.id}`);
    return doc;
  }

  async getById(id: string): Promise<Document | null> {
    const result = await this.db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();

    if (!result) return null;
    return rowToDocument(result);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
  }

  /**
   * Relaxed scope list — mirrors memory list. For each provided scope
   * dimension K, the row passes when `row[K] = ? OR row[K] IS NULL`, so
   * rows with null on a dimension (e.g. agent-only knowledge with no
   * user_id) surface alongside rows that match the caller's value.
   *
   * When no scope filter is provided, every document in the product
   * matches (admin-style inventory view).
   */
  async list(
    filters: DocumentListFilters,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<Document>> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (filters.user_id) {
      conditions.push('(user_id = ? OR user_id IS NULL)');
      bindings.push(filters.user_id);
    }
    if (filters.agent_id) {
      conditions.push('(agent_id = ? OR agent_id IS NULL)');
      bindings.push(filters.agent_id);
    }
    if (filters.session_id) {
      conditions.push('(session_id = ? OR session_id IS NULL)');
      bindings.push(filters.session_id);
    }
    if (filters.document_type) {
      conditions.push('document_type = ?');
      bindings.push(filters.document_type);
    }
    if (filters.file_type) {
      conditions.push('file_type = ?');
      bindings.push(filters.file_type);
    }
    if (pagination.cursor) {
      // Composite cursor: "uploaded_at|id" for stable pagination.
      const [cursorTime, cursorId] = pagination.cursor.split('|');
      conditions.push('(uploaded_at < ? OR (uploaded_at = ? AND id < ?))');
      bindings.push(cursorTime, cursorTime, cursorId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Fetch one extra to determine if there's a next page.
    const limit = pagination.limit + 1;
    bindings.push(limit);

    const { results } = await this.db
      .prepare(`SELECT * FROM documents ${where} ORDER BY uploaded_at DESC, id DESC LIMIT ?`)
      .bind(...bindings)
      .all();

    const hasMore = results.length > pagination.limit;
    const items = results.slice(0, pagination.limit).map(rowToDocument);
    const lastItem = items[items.length - 1];
    const cursor = hasMore && lastItem ? `${lastItem.uploaded_at}|${lastItem.id}` : null;

    return { items, cursor };
  }

  async update(id: string, input: DocumentUpdateInput): Promise<Document> {
    const sets: string[] = [];
    const bindings: unknown[] = [];

    const assign = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      bindings.push(value);
    };

    if (input.r2_key !== undefined) assign('r2_key', input.r2_key);
    if (input.filename !== undefined) assign('filename', input.filename);
    if (input.mime_type !== undefined) assign('mime_type', input.mime_type);
    if (input.size_bytes !== undefined) assign('size_bytes', input.size_bytes);
    if (input.file_type !== undefined) assign('file_type', input.file_type);
    if (input.document_type !== undefined) assign('document_type', input.document_type);
    if (input.description !== undefined) assign('description', input.description);
    if (input.user_id !== undefined) assign('user_id', input.user_id);
    if (input.agent_id !== undefined) assign('agent_id', input.agent_id);
    if (input.session_id !== undefined) assign('session_id', input.session_id);
    if (input.metadata !== undefined)
      assign('metadata', input.metadata ? JSON.stringify(input.metadata) : null);

    if (sets.length === 0) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`Document ${id} not found`);
      return existing;
    }

    bindings.push(id);
    await this.db
      .prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...bindings)
      .run();

    const updated = await this.getById(id);
    if (!updated) throw new Error(`Document ${id} not found`);
    return updated;
  }

  async listCleanupRefsByScope(scope: ScopeKeys, limit: number): Promise<DocumentCleanupRef[]> {
    const { conditions, bindings } = buildStrictScopeWhere(scope);
    const { results } = await this.db
      .prepare(`SELECT id, r2_key FROM documents WHERE ${conditions.join(' AND ')} LIMIT ?`)
      .bind(...bindings, limit)
      .all<DocumentCleanupRef>();
    return results;
  }

  async listAllCleanupRefs(limit: number): Promise<DocumentCleanupRef[]> {
    const { results } = await this.db
      .prepare('SELECT id, r2_key FROM documents LIMIT ?')
      .bind(limit)
      .all<DocumentCleanupRef>();
    return results;
  }

  async deleteByScope(scope: ScopeKeys): Promise<number> {
    const { conditions, bindings } = buildStrictScopeWhere(scope);
    const result = await this.db
      .prepare(`DELETE FROM documents WHERE ${conditions.join(' AND ')}`)
      .bind(...bindings)
      .run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM documents').run();
    return result.meta.changes ?? 0;
  }
}
