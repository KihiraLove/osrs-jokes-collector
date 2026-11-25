import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { DatabaseLifecycle } from './db/database.ts';
import { registerSubmissions } from './submissions/routes.ts';
import type { SubmissionOptions } from './submissions/routes.ts';
import { registerAdmin } from './admin/routes.ts';
import type { AdminOptions } from './admin/routes.ts';

export function createApp(database: DatabaseLifecycle, logger: FastifyServerOptions['logger'] = false, admin?: AdminOptions, submissions?: SubmissionOptions): FastifyInstance {
  let styles = '';
  let submissionScript = '';
  const safeLogger = !logger ? false : {
    ...(typeof logger === 'object' ? logger : {}),
    redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body', 'res.headers.set-cookie'],
    serializers: { req: (request: { method: string; url?: string }) => ({ method: request.method, url: (request.url ?? '/').split('?')[0] ?? '/' }) },
  };
  const app = Fastify({ logger: safeLogger, trustProxy: admin?.settings.trustProxy ?? false, bodyLimit: 65_536, requestTimeout: 10_000, forceCloseConnections: 'idle' });

  app.addHook('onReady', async () => {
    styles = await readFile(new URL('./public/styles.css', import.meta.url), 'utf8');
    submissionScript = await readFile(new URL('./public/submission.js', import.meta.url), 'utf8');
    await database.initialize();
    if (admin) {
      const key = await admin.store.initialize();
      if (key !== null) admin.onInitialKey(key);
    }
  });
  app.addHook('onClose', () => database.close());
  registerSubmissions(app, submissions);
  app.get('/styles.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(styles));
  app.get('/submission.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(submissionScript));
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
  if (admin) registerAdmin(app, admin);
  return app;
}
