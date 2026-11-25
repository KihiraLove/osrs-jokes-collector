import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { transaction } from './transaction.ts';

const migrationDirectory = new URL('./migrations/', import.meta.url);
// Two fixed int32 keys identifying this application's migration lock: OSRS, JOKE.
const migrationLock = [0x4f535253, 0x4a4f4b45];

export async function migrate(pool: Pool): Promise<void> {
  const filenames = (await readdir(migrationDirectory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (filenames.length === 0) throw new Error('No database migrations were found.');
  if (new Set(filenames.map(name => name.slice(0, 3))).size !== filenames.length) {
    throw new Error('Database migration versions must be unique.');
  }
  const migrations = await Promise.all(filenames.map(async version => {
    const sql = await readFile(new URL(version, migrationDirectory), 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));

  await transaction(pool, async client => {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', migrationLock);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    for (const [index, record] of applied.rows.entries()) {
      const expected = migrations[index];
      if (expected?.version !== record.version || expected.checksum !== record.checksum) {
        throw new Error('Database migration history differs from this application. Restore the matching release or add a new migration.');
      }
    }
    for (const migration of migrations.slice(applied.rowCount ?? 0)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
    }
  });
}
