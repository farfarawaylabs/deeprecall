import type { IIdempotencyRepository } from '../interfaces';

export class D1IdempotencyRepository implements IIdempotencyRepository {
  constructor(private db: D1Database) {}

  async check(key: string): Promise<string | null> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare('SELECT response FROM idempotency_keys WHERE key = ? AND expires_at > ?')
      .bind(key, now)
      .first<{ response: string }>();

    return result?.response ?? null;
  }

  async store(key: string, response: string, ttlHours: number): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys (key, response, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(key, response, now.toISOString(), expiresAt)
      .run();
  }

  async cleanup(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?')
      .bind(now)
      .run();

    return result.meta.changes ?? 0;
  }
}
