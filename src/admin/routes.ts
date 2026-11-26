import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AdminSettings } from './config.ts';
import { CHALLENGE_SECONDS, csrfTokenForSession, isToken, matchesCsrf, SESSION_SECONDS } from './store.ts';
import type { AdminSession, AdminStore } from './store.ts';
import { renderAdmin, renderAdminError, renderLogin } from '../views/admin.ts';
import type { JokeRepository } from '../db/repository.ts';
import { registerModeration } from './moderation.ts';
import { registerDecks } from './decks.ts';
import { ValidationError } from '../domain.ts';

declare module 'fastify' {
  interface FastifyRequest {
    adminSession: AdminSession | null;
    adminToken: string | null;
  }
  interface FastifyContextConfig { adminPublic?: boolean }
}

export interface AdminOptions {
  store: AdminStore;
  settings: AdminSettings;
  onInitialKey(key: string): void;
  repository?: JokeRepository;
  // New curation/export routes belong in this protected scope.
  routes?: (admin: FastifyInstance) => void | Promise<void>;
}

function bodyField(request: FastifyRequest, field: string): unknown {
  return request.body && typeof request.body === 'object' && Object.hasOwn(request.body, field)
    ? (request.body as Record<string, unknown>)[field] : undefined;
}

function validOrigin(request: FastifyRequest, expected: string): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (request.headers.origin !== undefined) return request.headers.origin === expected;
  try {
    return typeof request.headers.referer === 'string' && new URL(request.headers.referer).origin === expected;
  } catch { return false; }
}

export function registerAdmin(app: FastifyInstance, options: AdminOptions): void {
  const { store, settings } = options;
  app.register(async admin => {
    await admin.register(cookie);
    await admin.register(formbody);
    admin.decorateRequest('adminSession', null);
    admin.decorateRequest('adminToken', null);
    const cookieOptions = { path: '/', httpOnly: true, secure: settings.secureCookies, sameSite: 'strict' as const };

    admin.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache').header('Vary', 'Cookie');
      reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      // Native form POSTs need a usable same-origin Origin/Referer for CSRF.
      reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
      if (request.method === 'POST' && request.routeOptions.url === '/admin/login') {
        const retry = await store.takeRateLimit('login', request.ip);
        if (retry !== null) return reply.header('Retry-After', retry).code(429).type('text/html').send(renderAdminError('Too many login attempts. Try again shortly.'));
      }
      const token = request.cookies[settings.cookieName];
      request.adminToken = isToken(token) ? token : null;
      request.adminSession = await store.session(token);
      if (!request.routeOptions.config.adminPublic && !request.adminSession?.authenticated) {
        reply.clearCookie(settings.cookieName, cookieOptions);
        return reply.code(401).type('text/html').send(renderAdminError('Log in to continue.'));
      }
    });

    admin.addHook('preHandler', async (request, reply) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      const bodyToken = bodyField(request, 'csrf');
      const headerToken = request.headers['x-csrf-token'];
      const token = headerToken ?? bodyToken;
      if (!validOrigin(request, settings.origin) || !request.adminSession || !request.adminToken
        || (bodyToken !== undefined && headerToken !== undefined && bodyToken !== headerToken)
        || !matchesCsrf(token, request.adminToken)) {
        return reply.code(403).type('text/html').send(renderAdminError('Request could not be verified. Reload the page and try again.'));
      }
    });

    admin.setErrorHandler((error, request, reply) => {
      if (error instanceof ValidationError) return reply.code(400).type('text/html').send(renderAdminError(error.message));
      const requestedStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof requestedStatus === 'number' && requestedStatus >= 400 && requestedStatus < 500 ? requestedStatus : 500;
      if (status === 500) request.log.error('Admin request failed.');
      // Parser/validation errors can contain submitted data: never echo/log them.
      reply.code(status).type('text/html').send(renderAdminError(status === 500 ? 'Admin data is temporarily unavailable. Please try again shortly.' : 'The request could not be completed. Please try again.'));
    });

    admin.get('/', { prefixTrailingSlash: 'both', config: { adminPublic: true } }, async (request, reply) => {
      if (request.adminSession?.authenticated && request.adminToken) {
        if (options.repository) return reply.code(303).header('Location', '/admin/jokes').send();
        return reply.type('text/html').send(renderAdmin(csrfTokenForSession(request.adminToken)));
      }
      let token = request.adminToken;
      if (!request.adminSession || !token) {
        const retry = await store.takeRateLimit('challenge', request.ip);
        if (retry !== null) return reply.header('Retry-After', retry).code(429).type('text/html').send(renderAdminError('Too many requests. Try again shortly.'));
        token = await store.createChallenge();
        reply.setCookie(settings.cookieName, token, { ...cookieOptions, maxAge: CHALLENGE_SECONDS });
      }
      return reply.type('text/html').send(renderLogin(csrfTokenForSession(token)));
    });

    admin.post('/login', { bodyLimit: 2_048, config: { adminPublic: true } }, async (request, reply) => {
      const key = bodyField(request, 'key');
      const token = await store.login(typeof key === 'string' ? key : '', request.adminToken!);
      if (!token) return reply.code(401).type('text/html').send(renderLogin(csrfTokenForSession(request.adminToken!), 'The admin key is invalid.'));
      reply.setCookie(settings.cookieName, token, { ...cookieOptions, maxAge: SESSION_SECONDS });
      return reply.code(303).header('Location', '/admin').send();
    });

    admin.post('/logout', async (request, reply) => {
      await store.revoke(request.adminToken!);
      reply.clearCookie(settings.cookieName, cookieOptions);
      return reply.code(303).header('Location', '/admin').send();
    });

    if (options.repository) {
      registerModeration(admin, options.repository);
      registerDecks(admin, options.repository);
    }
    if (options.routes) await options.routes(admin);
    admin.setNotFoundHandler((_request, reply) => reply.code(404).type('text/html').send(renderAdminError('Page not found.')));
  }, { prefix: '/admin' });
}
