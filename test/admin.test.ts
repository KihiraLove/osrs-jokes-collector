import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { migrate } from '../src/db/migrations.ts';
import { adminSettings } from '../src/admin/config.ts';
import type { AdminSettings } from '../src/admin/config.ts';
import { AdminStore, csrfTokenForSession, isToken, secretDigest } from '../src/admin/store.ts';
import { escapeHtml } from '../src/views/admin.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

describe('admin authentication', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => {
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
  });
  after(async () => {
    await maintenance?.end();
    await database?.close();
  });

  interface FixtureOptions {
    settings?: AdminSettings;
    logger?: FastifyServerOptions['logger'];
    ready?: boolean;
  }

  async function fixture(context: TestContext, options: FixtureOptions = {}) {
    const schema = `admin_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const settings = options.settings ?? adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://jokes.example.com' });
    const printed: string[] = [];
    const applications: FastifyInstance[] = [];
    function openApp() {
      const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
      const store = new AdminStore(pool);
      const app = createApp(databaseLifecycle(pool), options.logger ?? false, {
        store, settings, onInitialKey: key => printed.push(key),
        routes: admin => {
          admin.get('/private', async () => ({ protected: true }));
          admin.post('/private', async () => ({ protected: true }));
          admin.put('/private', async () => ({ protected: true }));
          admin.delete('/private', async () => ({ protected: true }));
          admin.get('/export', async () => ({ decks: [] }));
        },
      });
      applications.push(app);
      return { app, pool, store };
    }
    context.after(async () => {
      try { await Promise.all(applications.map(app => app.close())); }
      finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    });
    const initial = openApp();
    if (options.ready !== false) await initial.app.ready();
    return { ...initial, settings, printed, openApp, schema };
  }

  function cookieFrom(response: { headers: Record<string, unknown> }): string {
    const values = response.headers['set-cookie'];
    const value = (Array.isArray(values) ? values : [values]).find(candidate => typeof candidate === 'string' && candidate.includes('osrs-jokes-admin'));
    assert.ok(typeof value === 'string', 'Expected an admin session cookie.');
    return value.split(';')[0]!;
  }
  function csrfFrom(response: { body: string }): string {
    const match = response.body.match(/name="csrf" value="([a-f0-9]{64})"/);
    assert.ok(match, 'Expected a CSRF field.');
    return match[1]!;
  }
  async function challenge(app: FastifyInstance, address = '127.0.0.1') {
    const page = await app.inject({ method: 'GET', url: '/admin', remoteAddress: address });
    assert.equal(page.statusCode, 200);
    return { page, cookie: cookieFrom(page), csrf: csrfFrom(page) };
  }
  async function signIn(app: FastifyInstance, key: string, origin: string) {
    const pending = await challenge(app);
    const response = await app.inject({ method: 'POST', url: '/admin/login', headers: {
      cookie: pending.cookie, origin, 'content-type': 'application/x-www-form-urlencoded',
    }, payload: new URLSearchParams({ key, csrf: pending.csrf }).toString() });
    assert.equal(response.statusCode, 303, 'Expected a successful admin login.');
    const cookie = cookieFrom(response);
    assert.ok(cookie !== pending.cookie, 'Login must replace the anonymous session.');
    return { cookie, response, pending };
  }

  test('admin initialization generates one verifier under concurrent starts', async context => {
    const f = await fixture(context, { ready: false });
    await migrate(f.pool);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.store.initialize()));
    const keys = results.filter((key): key is string => key !== null);
    assert.equal(keys.length, 1);
    assert.ok(isToken(keys[0]));
    const stored = await f.pool.query('SELECT * FROM admin_credentials');
    assert.equal(stored.rowCount, 1);
    assert.ok(stored.rows[0].key_hash.equals(secretDigest(keys[0]!)));
    assert.ok(!JSON.stringify(stored.rows).includes(keys[0]!));
    await f.app.ready();
    assert.equal(f.printed.length, 0, 'An already committed credential is never reprinted.');
  });

  test('admin migration upgrades an existing collection without losing jokes or deck IDs', async context => {
    const f = await fixture(context, { ready: false });
    const originalSql = await readFile(new URL('../src/db/migrations/001_initial.sql', import.meta.url), 'utf8');
    await f.pool.query(originalSql);
    await f.pool.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    await f.pool.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', ['001_initial.sql', createHash('sha256').update(originalSql).digest('hex')]);
    const id = randomUUID();
    await f.pool.query("INSERT INTO decks (id, name, normalized_name) VALUES ($1, 'Existing deck', 'existing deck')", [id]);
    await f.pool.query("INSERT INTO jokes (kind, text, deck_id) VALUES ('single', 'Existing joke', $1)", [id]);
    await f.app.ready();
    const result = await f.pool.query('SELECT deck_id, text FROM jokes');
    assert.equal(result.rows[0].deck_id, id);
    assert.equal(result.rows[0].text, 'Existing joke');
    assert.equal(f.printed.length, 1);
    assert.equal((await f.pool.query('SELECT * FROM admin_rate_limits')).rowCount, 0);
  });

  test('admin key and authenticated sessions persist across application restarts', async context => {
    const f = await fixture(context);
    assert.equal(f.printed.length, 1);
    const login = await signIn(f.app, f.printed[0]!, f.settings.origin);
    const rawToken = login.cookie.split('=')[1]!;
    const rows = await f.pool.query('SELECT * FROM admin_sessions');
    assert.ok(!JSON.stringify(rows.rows).includes(rawToken));
    assert.equal((await f.store.session(rawToken))?.authenticated, true);
    await f.app.close();
    const next = f.openApp();
    await next.app.ready();
    assert.equal(f.printed.length, 1);
    const page = await next.app.inject({ url: '/admin', headers: { cookie: login.cookie } });
    assert.match(page.body, /action="\/admin\/logout"/);
    assert.equal(page.headers['cache-control'], 'private, no-store');
  });

  test('admin login rejects blank, incorrect and malformed keys with the same generic response', async context => {
    const f = await fixture(context);
    const pending = await challenge(f.app);
    for (const key of ['', 'wrong', randomBytes(32).toString('hex'), '<script>alert(1)</script>']) {
      const result = await f.app.inject({ method: 'POST', url: '/admin/login', headers: { cookie: pending.cookie, origin: f.settings.origin }, payload: { csrf: pending.csrf, key } });
      assert.equal(result.statusCode, 401);
      assert.match(result.body, /The admin key is invalid\./);
      if (key) assert.ok(!result.body.includes(key));
    }
    assert.ok(!pending.page.body.includes('name="username"'));
    assert.match(pending.page.body, /type="password"/);
  });

  test('admin state changes enforce origin, CSRF and server-side authentication', async context => {
    const f = await fixture(context);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      assert.equal((await f.app.inject({ method, url: '/admin/private' })).statusCode, 401);
    }
    assert.equal((await f.app.inject('/admin/export')).statusCode, 401);
    const pending = await challenge(f.app);
    const cases = [
      { headers: { origin: 'https://evil.example' }, csrf: pending.csrf },
      { headers: {}, csrf: pending.csrf },
      { headers: { origin: f.settings.origin }, csrf: 'bad' },
    ];
    for (const [index, entry] of cases.entries()) {
      const response = await f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: `198.51.100.${index + 1}`,
        headers: { cookie: pending.cookie, ...entry.headers }, payload: { csrf: entry.csrf, key: f.printed[0] } });
      assert.equal(response.statusCode, 403);
    }
    const forged = randomBytes(32).toString('hex');
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/login', headers: { cookie: `${f.settings.cookieName}=${forged}`, origin: f.settings.origin }, payload: { csrf: csrfTokenForSession(forged), key: f.printed[0] } })).statusCode, 403);
    const login = await signIn(f.app, f.printed[0]!, f.settings.origin);
    const dashboard = await f.app.inject({ url: '/admin', headers: { cookie: login.cookie } });
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/private', headers: { cookie: login.cookie, origin: f.settings.origin }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/private', headers: { cookie: login.cookie, origin: f.settings.origin, 'x-csrf-token': csrfFrom(dashboard) }, payload: {} })).statusCode, 200);
  });

  test('admin logout and expiry revoke access without GET side effects', async context => {
    const f = await fixture(context);
    const login = await signIn(f.app, f.printed[0]!, f.settings.origin);
    const page = await f.app.inject({ url: '/admin', headers: { cookie: login.cookie } });
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie: login.cookie, origin: f.settings.origin }, payload: {} })).statusCode, 403);
    await f.app.inject({ method: 'GET', url: '/admin/logout', headers: { cookie: login.cookie } });
    assert.equal((await f.app.inject({ url: '/admin/private', headers: { cookie: login.cookie } })).statusCode, 200);
    const result = await f.app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie: login.cookie, origin: f.settings.origin }, payload: { csrf: csrfFrom(page) } });
    assert.equal(result.statusCode, 303);
    assert.match(String(result.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await f.app.inject({ url: '/admin/private', headers: { cookie: login.cookie } })).statusCode, 401);
    const next = await signIn(f.app, f.printed[0]!, f.settings.origin);
    await f.pool.query("UPDATE admin_sessions SET created_at = clock_timestamp() - INTERVAL '2 hours', expires_at = clock_timestamp() - INTERVAL '1 second'");
    assert.equal((await f.app.inject({ url: '/admin/private', headers: { cookie: next.cookie } })).statusCode, 401);
  });

  test('admin key rotation cannot leave an old-key concurrent login authenticated', async context => {
    const f = await fixture(context);
    let key = f.printed[0]!;
    for (let index = 0; index < 8; index++) {
      const pending = await f.store.createChallenge();
      const [session, replacement] = await Promise.all([f.store.login(key, pending), f.store.rotateKey()]);
      if (session) assert.equal(await f.store.session(session), null);
      assert.equal(await f.store.login(key, await f.store.createChallenge()), null);
      key = replacement;
    }
    const current = await f.store.login(key, await f.store.createChallenge());
    assert.ok(current && (await f.store.session(current))?.authenticated);
  });

  test('admin login rate limiting persists and ignores spoofed forwarding headers by default', async context => {
    const f = await fixture(context);
    const pending = await challenge(f.app);
    for (let index = 0; index < 5; index++) {
      const response = await f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '198.51.100.7', headers: { cookie: pending.cookie, origin: f.settings.origin, 'x-forwarded-for': `203.0.113.${index}` }, payload: { csrf: pending.csrf, key: 'wrong' } });
      assert.equal(response.statusCode, 401);
    }
    const next = f.openApp();
    await next.app.ready();
    const blocked = await next.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '198.51.100.7', headers: { cookie: pending.cookie, origin: f.settings.origin, 'x-forwarded-for': '203.0.113.99' }, payload: { csrf: pending.csrf, key: f.printed[0] } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    await f.pool.query("UPDATE admin_rate_limits SET window_started_at = clock_timestamp() - INTERVAL '2 minutes'");
    assert.equal((await next.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '198.51.100.7', headers: { cookie: pending.cookie, origin: f.settings.origin }, payload: { csrf: pending.csrf, key: f.printed[0] } })).statusCode, 303);
  });

  test('admin trusted proxy configuration uses the validated chain and keeps cookies secure', async context => {
    const settings = adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://jokes.example.com', TRUSTED_PROXY_CIDRS: '192.0.2.1/32' });
    const f = await fixture(context, { settings });
    const pending = await challenge(f.app);
    assert.match(String(pending.page.headers['set-cookie']), /__Host-osrs-jokes-admin=.*HttpOnly; Secure; SameSite=Strict/);
    for (let index = 0; index < 5; index++) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '192.0.2.1', headers: { cookie: pending.cookie, origin: settings.origin, 'x-forwarded-for': `203.0.113.${index}, 198.51.100.7` }, payload: { csrf: pending.csrf, key: 'wrong' } })).statusCode, 401);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '192.0.2.1', headers: { cookie: pending.cookie, origin: settings.origin, 'x-forwarded-for': '203.0.113.99, 198.51.100.7' }, payload: { csrf: pending.csrf, key: f.printed[0] } })).statusCode, 429);
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: '192.0.2.1', headers: { cookie: pending.cookie, origin: settings.origin, 'x-forwarded-for': '198.51.100.8' }, payload: { csrf: pending.csrf, key: f.printed[0] } })).statusCode, 303);
  });

  test('admin logs and parser failures never echo credentials, cookies or query secrets', async context => {
    let log = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { log += chunk.toString(); callback(); } });
    const f = await fixture(context, { logger: { stream } });
    const key = f.printed[0]!;
    const login = await signIn(f.app, key, f.settings.origin);
    await f.app.inject({ url: `/admin?key=${key}`, headers: { cookie: login.cookie } });
    const page = await challenge(f.app);
    const failure = await f.app.inject({ method: 'POST', url: '/admin/login', headers: { cookie: page.cookie, origin: f.settings.origin, 'content-type': 'application/json' }, payload: `{"key":"${key}" invalid` });
    assert.equal(failure.statusCode, 400);
    assert.ok(!failure.body.includes(key));
    await f.app.close();
    for (const secret of [key, login.cookie.split('=')[1]!, page.cookie.split('=')[1]!]) assert.ok(!log.includes(secret), 'Logs must not contain raw authentication secrets.');
    assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
  });

  test('admin HTTP cookies require isolated loopback development configuration', () => {
    assert.throws(() => adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }), /HTTP admin access/);
    assert.throws(() => adminSettings({ PUBLIC_ORIGIN: 'http://example.com' }), /HTTP admin access/);
    const local = adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://127.0.0.1:3000', ALLOW_INSECURE_LOCAL_ADMIN: 'true' });
    assert.equal(local.secureCookies, false);
    assert.ok(!local.cookieName.startsWith('__Host-'));
    assert.throws(() => adminSettings({ PUBLIC_ORIGIN: 'https://example.com/path' }), /PUBLIC_ORIGIN/);
    for (const proxies of ['true', '0.0.0.0/0', '::/0', '192.0.2.1/99']) assert.throws(() => adminSettings({ TRUSTED_PROXY_CIDRS: proxies }), /TRUSTED_PROXY_CIDRS/);
  });

  test('admin server stdout and operator CLI preserve and rotate the key over real HTTP', async context => {
    const f = await fixture(context, { ready: false });
    const port = await new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        assert.ok(address && typeof address !== 'string');
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: database.connectionString, PGOPTIONS: `-c search_path=${f.schema}`,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', PUBLIC_ORIGIN: origin, ALLOW_INSECURE_LOCAL_ADMIN: 'true' };
    delete environment.PGPASSWORD_FILE;
    delete environment.PGPASSWORD;
    let current: { process: ReturnType<typeof spawn>; output: string } | undefined;
    async function stop() {
      const child = current?.process;
      if (!child || child.exitCode !== null || !child.pid) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Admin server shutdown timed out.')); }, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    async function start() {
      const instance = { process: spawn(process.execPath, ['src/server.ts'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }), output: '' };
      current = instance;
      instance.process.stdout?.on('data', chunk => { instance.output += chunk.toString(); });
      instance.process.stderr?.on('data', () => {});
      let spawnError: Error | undefined;
      instance.process.once('error', error => { spawnError = error; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (spawnError || instance.process.exitCode !== null) throw new Error('Admin server failed to start.');
        try {
          if ((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(300) })).status === 200) return instance;
        } catch { /* wait for the listener */ }
        await delay(50);
      }
      throw new Error('Admin server readiness timed out.');
    }
    async function httpLogin(key: string, expected = 303) {
      const page = await fetch(`${origin}/admin`);
      const pending = { cookie: page.headers.getSetCookie()[0]!.split(';')[0]!, csrf: csrfFrom({ body: await page.text() }) };
      const response = await fetch(`${origin}/admin/login`, { method: 'POST', redirect: 'manual', headers: {
        Origin: origin, Cookie: pending.cookie, 'Content-Type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ key, csrf: pending.csrf }) });
      assert.equal(response.status, expected);
      return response.headers.getSetCookie()[0]?.split(';')[0];
    }
    try {
      const initial = await start();
      const keys = [...initial.output.matchAll(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/gm)];
      assert.equal(keys.length, 1);
      const key = keys[0]![1]!;
      const cookie = await httpLogin(key);
      assert.ok(cookie);
      await stop();
      const restarted = await start();
      assert.ok(!restarted.output.includes('OSRS_JOKES_ADMIN_KEY='));
      const dashboard = await fetch(`${origin}/admin`, { headers: { Cookie: cookie } });
      assert.match(await dashboard.text(), /action="\/admin\/logout"/);
      const rotated = await promisify(execFile)(process.execPath, ['src/admin-key.ts', 'rotate'], { env: environment, timeout: 10_000 });
      const replacement = rotated.stdout.match(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/m)?.[1];
      assert.ok(replacement && replacement !== key);
      const revoked = await fetch(`${origin}/admin`, { headers: { Cookie: cookie } });
      assert.match(await revoked.text(), /name="key"/);
      await httpLogin(key, 401);
      await httpLogin(replacement);
    } finally {
      await stop();
    }
  });
});
