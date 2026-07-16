import type { IDeadLetterRepository, DeadLetterEntry } from '../interfaces';

export class D1DeadLetterRepository implements IDeadLetterRepository {
  constructor(private db: D1Database) {}

  async create(entry: DeadLetterEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dead_letters (id, queue_name, payload, error, attempts, first_failed_at, last_failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.id,
        entry.queue_name,
        entry.payload,
        entry.error,
        entry.attempts,
        entry.first_failed_at,
        entry.last_failed_at,
      )
      .run();
  }

  async getById(id: string): Promise<DeadLetterEntry | null> {
    const result = await this.db
      .prepare('SELECT * FROM dead_letters WHERE id = ?')
      .bind(id)
      .first<DeadLetterEntry>();

    return result ?? null;
  }

  async list(limit: number): Promise<DeadLetterEntry[]> {
    const result = await this.db
      .prepare('SELECT * FROM dead_letters ORDER BY last_failed_at DESC LIMIT ?')
      .bind(limit)
      .all<DeadLetterEntry>();

    return result.results;
  }

  async count(): Promise<number> {
    const result = await this.db
      .prepare('SELECT COUNT(*) as count FROM dead_letters')
      .first<{ count: number }>();

    return result?.count ?? 0;
  }

  async deleteById(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM dead_letters WHERE id = ?').bind(id).run();
  }
}
