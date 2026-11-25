import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { migrate } from './migrations.ts';

export interface DatabaseLifecycle {
  initialize(): Promise<void>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createPool(config: PoolConfig = {}): Pool {
  return new Pool({
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    ...config,
  });
}

export function databaseLifecycle(pool: Pool): DatabaseLifecycle {
  return {
    initialize: () => migrate(pool),
    check: async () => { await pool.query('SELECT 1'); },
    close: () => pool.end(),
  };
}
