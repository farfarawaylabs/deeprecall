import type { AuditAction, AuditTrigger } from '@deeprecall/types';
import type { IAuditRepository, AuditEntry, ScopeKeys } from '../interfaces';
import { D1_MAX_BOUND_PARAMS } from '../constants';

export class D1AuditRepository implements IAuditRepository {
  constructor(private db: D1Database) {}

  async log(
    action: AuditAction,
    memoryId: string,
    reason: string | null,
    oldValue: unknown | null,
    newValue: unknown | null,
    triggeredBy: AuditTrigger,
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO memory_audit (id, memory_id, action, reason, old_value, new_value, triggered_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        memoryId,
        action,
        reason,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        triggeredBy,
        now,
      )
      .run();
  }

  async deleteByMemoryIds(memoryIds: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < memoryIds.length; i += D1_MAX_BOUND_PARAMS) {
      const chunk = memoryIds.slice(i, i + D1_MAX_BOUND_PARAMS);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.db
        .prepare(`DELETE FROM memory_audit WHERE memory_id IN (${placeholders})`)
        .bind(...chunk)
        .run();
      deleted += result.meta.changes ?? 0;
    }
    return deleted;
  }

  async listRecent(scope: ScopeKeys, limit: number): Promise<AuditEntry[]> {
    // Relaxed scope match — null on memory passes (same as listByScope).
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (scope.user_id) {
      conditions.push('(m.user_id = ? OR m.user_id IS NULL)');
      bindings.push(scope.user_id);
    }
    if (scope.agent_id) {
      conditions.push('(m.agent_id = ? OR m.agent_id IS NULL)');
      bindings.push(scope.agent_id);
    }
    if (conditions.length === 0) {
      throw new Error('Scope must include at least one of user_id or agent_id');
    }
    const where = conditions.join(' AND ');

    const { results } = await this.db
      .prepare(
        `SELECT ma.* FROM memory_audit ma
         JOIN memories m ON ma.memory_id = m.id
         WHERE ${where}
         ORDER BY ma.created_at DESC
         LIMIT ?`,
      )
      .bind(...bindings, limit)
      .all();

    return results.map(
      (row) =>
        ({
          id: row.id,
          memory_id: row.memory_id,
          action: row.action,
          reason: (row.reason as string) ?? null,
          old_value: (row.old_value as string) ?? null,
          new_value: (row.new_value as string) ?? null,
          triggered_by: row.triggered_by,
          created_at: row.created_at,
        }) as AuditEntry,
    );
  }

  async getByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM memory_audit WHERE memory_id = ? ORDER BY created_at ASC')
      .bind(memoryId)
      .all();

    return results.map(
      (row) =>
        ({
          id: row.id,
          memory_id: row.memory_id,
          action: row.action,
          reason: (row.reason as string) ?? null,
          old_value: (row.old_value as string) ?? null,
          new_value: (row.new_value as string) ?? null,
          triggered_by: row.triggered_by,
          created_at: row.created_at,
        }) as AuditEntry,
    );
  }
}
