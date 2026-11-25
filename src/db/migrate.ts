import { createPool } from './database.ts';
import { migrate } from './migrations.ts';
import { databaseConfig } from '../runtime/database-config.ts';

const pool = createPool(await databaseConfig());
try {
  await migrate(pool);
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
