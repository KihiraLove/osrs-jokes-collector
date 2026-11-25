import { ADMIN_KEY_LABEL, AdminStore } from './admin/store.ts';
import { createPool } from './db/database.ts';
import { migrate } from './db/migrations.ts';
import { databaseConfig, startupFailureMessage } from './runtime/database-config.ts';

if (process.argv.length !== 3 || process.argv[2] !== 'rotate') {
  console.error('Usage: node dist/admin-key.js rotate');
  process.exitCode = 1;
} else {
  const pool = createPool(await databaseConfig());
  pool.on('error', () => { process.exitCode = 1; });
  try {
    await migrate(pool);
    const key = await new AdminStore(pool).rotateKey();
    console.log(`${ADMIN_KEY_LABEL}${key}`);
  } catch (error) {
    console.error(startupFailureMessage(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
