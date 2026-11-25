import { createPool } from './database.ts';
import { migrate } from './migrations.ts';

const pool = createPool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
try {
  await migrate(pool);
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
