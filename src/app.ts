import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DatabaseLifecycle } from './db/database.ts';
import { renderHome } from './views/home.ts';

export function createApp(database: DatabaseLifecycle, logger = false): FastifyInstance {
  let styles = '';
  const app = Fastify({ logger, trustProxy: false, bodyLimit: 65_536, requestTimeout: 10_000, forceCloseConnections: 'idle' });

  app.addHook('onReady', async () => {
    styles = await readFile(new URL('./public/styles.css', import.meta.url), 'utf8');
    await database.initialize();
  });
  app.addHook('onClose', () => database.close());
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderHome()));
  app.get('/styles.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(styles));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await database.check();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
