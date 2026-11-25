import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../db/transaction.ts';

// Shared across app processes; short-lived hashes never enter joke records.
export class SubmissionLimiter {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async take(address: string): Promise<number | null> {
    return transaction(this.pool, async client => {
      await client.query("DELETE FROM submission_rate_limits WHERE window_started_at <= clock_timestamp() - INTERVAL '1 minute'");
      for (const [key, maximum] of [['global', 100], [`ip:${address}`, 5]] as const) {
        const result = await client.query<{ attempts: number; retryAfter: number }>(`INSERT INTO submission_rate_limits (key_hash, attempts)
          VALUES ($1, 1) ON CONFLICT (key_hash) DO UPDATE SET attempts = LEAST(submission_rate_limits.attempts + 1, 1001)
          RETURNING attempts, CEIL(EXTRACT(EPOCH FROM (window_started_at + INTERVAL '1 minute' - clock_timestamp())))::int AS "retryAfter"`,
        [createHash('sha256').update(key).digest()]);
        if (result.rows[0]!.attempts > maximum) return Math.max(1, result.rows[0]!.retryAfter);
      }
      return null;
    });
  }
}
