import type { PoolConfig } from 'pg';
import { readGeneratedPassword, RECOVERY_HINT } from './secrets.ts';

export async function databaseConfig(environment: NodeJS.ProcessEnv = process.env): Promise<PoolConfig> {
  if (environment.PGPASSWORD_FILE) {
    if (environment.DATABASE_URL || environment.PGPASSWORD) {
      throw new Error('Use PGPASSWORD_FILE by itself, without DATABASE_URL or PGPASSWORD.');
    }
    try {
      return { password: await readGeneratedPassword(environment.PGPASSWORD_FILE) };
    } catch (cause) {
      throw new Error(`Cannot read the generated database password file. ${RECOVERY_HINT}`, { cause });
    }
  }
  return environment.DATABASE_URL ? { connectionString: environment.DATABASE_URL } : {};
}

export function startupFailureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && (error.code === '28P01' || error.code === '28000')) {
    return `Database authentication failed. ${RECOVERY_HINT}`;
  }
  return 'Server startup failed. Check database connectivity and migration history.';
}
