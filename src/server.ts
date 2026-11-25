import { createApp } from './app.ts';
import { createPool, databaseLifecycle } from './db/database.ts';
import { databaseConfig, startupFailureMessage } from './runtime/database-config.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');
const pool = createPool(await databaseConfig());
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
} catch (error) {
  app.log.error(startupFailureMessage(error));
  process.exitCode = 1;
  await shutdown();
}
