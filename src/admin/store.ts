import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db/transaction.ts';

export const ADMIN_KEY_LABEL = 'OSRS_JOKES_ADMIN_KEY=';
export const SESSION_SECONDS = 8 * 60 * 60;
export const CHALLENGE_SECONDS = 15 * 60;
const credentialLock = [0x4f535253, 0x41555448]; // OSRS, AUTH

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function secretDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function csrfTokenForSession(token: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update('osrs-jokes-collector/admin-csrf/v1').digest('hex');
}

export function matchesCsrf(value: unknown, token: string): boolean {
  return isToken(value) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(csrfTokenForSession(token), 'hex'));
}

export interface AdminSession {
  authenticated: boolean;
  expiresAt: Date;
}

async function insertSession(client: PoolClient, authenticated: boolean): Promise<string> {
  await client.query('DELETE FROM admin_sessions WHERE expires_at <= clock_timestamp()');
  const token = randomBytes(32).toString('hex');
  await client.query(`INSERT INTO admin_sessions (token_hash, authenticated, expires_at)
    VALUES ($1, $2, clock_timestamp() + $3::int * INTERVAL '1 second')`,
  [secretDigest(token), authenticated, authenticated ? SESSION_SECONDS : CHALLENGE_SECONDS]);
  return token;
}

export class AdminStore {
  private readonly pool: Pool;

  constructor(pool: Pool) { this.pool = pool; }

  async initialize(): Promise<string | null> {
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', credentialLock);
      const existing = await client.query('SELECT id FROM admin_credentials WHERE id = true');
      if (existing.rowCount) return null;
      const key = randomBytes(32).toString('hex');
      await client.query('INSERT INTO admin_credentials (key_hash) VALUES ($1)', [secretDigest(key)]);
      return key;
    });
  }

  async rotateKey(): Promise<string> {
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', credentialLock);
      const key = randomBytes(32).toString('hex');
      // This update conflicts with the share lock held by login. An old-key
      // login cannot insert a fresh session after rotation revoked sessions.
      await client.query(`INSERT INTO admin_credentials (key_hash) VALUES ($1)
        ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, created_at = clock_timestamp()`, [secretDigest(key)]);
      await client.query('DELETE FROM admin_sessions');
      return key;
    });
  }

  async createChallenge(): Promise<string> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM admin_credentials WHERE id = true FOR SHARE');
      return insertSession(client, false);
    });
  }

  async session(token: unknown): Promise<AdminSession | null> {
    if (!isToken(token)) return null;
    const result = await this.pool.query<AdminSession>(`SELECT authenticated, expires_at AS "expiresAt"
      FROM admin_sessions WHERE token_hash = $1 AND expires_at > clock_timestamp()`, [secretDigest(token)]);
    return result.rows[0] ?? null;
  }

  async login(candidate: string, challenge: string): Promise<string | null> {
    if (!isToken(challenge)) return null;
    return transaction(this.pool, async client => {
      const credential = await client.query<{ key_hash: Buffer }>('SELECT key_hash FROM admin_credentials WHERE id = true FOR SHARE');
      const pending = await client.query(`SELECT token_hash FROM admin_sessions
        WHERE token_hash = $1 AND NOT authenticated AND expires_at > clock_timestamp() FOR UPDATE`, [secretDigest(challenge)]);
      const key = candidate.trim();
      if (!credential.rows[0] || !pending.rowCount || !isToken(key)
        || !timingSafeEqual(secretDigest(key), credential.rows[0].key_hash)) return null;
      await client.query('DELETE FROM admin_sessions WHERE token_hash = $1', [secretDigest(challenge)]);
      return insertSession(client, true);
    });
  }

  async revoke(token: string): Promise<void> {
    if (isToken(token)) await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [secretDigest(token)]);
  }

  async takeRateLimit(scope: 'login' | 'challenge', address: string): Promise<number | null> {
    return transaction(this.pool, async client => {
      await client.query("DELETE FROM admin_rate_limits WHERE window_started_at <= clock_timestamp() - INTERVAL '1 minute'");
      const limits = [
        { key: `${scope}:global`, maximum: scope === 'login' ? 100 : 300 },
        { key: `${scope}:ip:${address}`, maximum: scope === 'login' ? 5 : 20 },
      ];
      for (const limit of limits) {
        const result = await client.query<{ attempts: number; retryAfter: number }>(`INSERT INTO admin_rate_limits (key_hash, attempts)
          VALUES ($1, 1) ON CONFLICT (key_hash) DO UPDATE SET attempts = LEAST(admin_rate_limits.attempts + 1, 1001)
          RETURNING attempts, CEIL(EXTRACT(EPOCH FROM (window_started_at + INTERVAL '1 minute' - clock_timestamp())))::int AS "retryAfter"`,
        [secretDigest(limit.key)]);
        if (result.rows[0]!.attempts > limit.maximum) return Math.max(1, result.rows[0]!.retryAfter);
      }
      return null;
    });
  }
}
