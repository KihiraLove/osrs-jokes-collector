import { createApp } from './app.ts';
import { createPool, databaseLifecycle } from './db/database.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');
const pool = createPool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
const app = createApp(databaseLifecycle(pool), true);
// Idle connection failures must not become unhandled EventEmitter errors.
pool.on('error', () => app.log.error('An idle database connection failed.'));

async function shutdown(): Promise<void> {
  try {
    await app.close();
  } catch {
    app.log.error('Server shutdown failed.');
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
} catch {
  app.log.error('Server startup failed. Check database connectivity and migration history.');
  process.exitCode = 1;
  await shutdown();
}
