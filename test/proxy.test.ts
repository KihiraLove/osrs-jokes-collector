import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { SubmissionLimiter } from '../src/submissions/limiter.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

describe('production proxy chain', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => { database = await startTestDatabase(); maintenance = createPool({ connectionString: database.connectionString }); });
  after(async () => { try { await maintenance?.end(); } finally { await database?.close(); } });

  async function fixture(context: TestContext) {
    const schema = `proxy_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
    const repository = new JokeRepository(pool);
    const origin = 'https://jokes.example.com';
    // Documentation address ranges stand in for actual Traefik/Cloudflare ranges.
    const settings = adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin, TRUSTED_PROXY_CIDRS: '192.0.2.10/32,2001:db8:1::10/128,203.0.113.0/24,2001:db8:2::/48' });
    let key = '';
    const app = createApp(databaseLifecycle(pool), false, { repository, store: new AdminStore(pool), settings, onInitialKey: value => { key = value; } }, { repository, limiter: new SubmissionLimiter(pool) });
    context.after(async () => { try { await app.close(); } finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); } });
    await app.ready();
    const headers = (visitor = '198.51.100.7', spoof = '198.18.0.1', edge = '203.0.113.10') => ({
      'x-forwarded-for': `${spoof}, ${visitor}, ${edge}`, 'cf-connecting-ip': spoof, 'true-client-ip': spoof,
      forwarded: `for=${spoof};proto=http;host=evil.example`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http',
    });
    const post = (remoteAddress: string, values: Record<string, string>) => app.inject({ method: 'POST', url: '/', remoteAddress, headers: values, payload: { kind: 'single', text: 'A proxied joke' } });
    return { app, repository, origin, key, headers, post };
  }
  const cookieFrom = (headers: Record<string, unknown>) => String(Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] : headers['set-cookie']).split(';')[0]!;
  const csrfFrom = (body: string) => body.match(/name="csrf" value="([a-f0-9]{64})"/)![1]!;

  test('two-hop IPv4/IPv6 chains rate-limit the real visitor despite changed spoofed prefixes and alternate client-IP headers', async context => {
    const f = await fixture(context);
    for (let index = 0; index < 5; index++) {
      assert.equal((await f.post('192.0.2.10', f.headers('198.51.100.7', `198.18.0.${index}`))).statusCode, 303);
    }
    assert.equal((await f.post('192.0.2.10', f.headers())).statusCode, 429);
    assert.equal((await f.post('192.0.2.10', f.headers('198.51.100.8'))).statusCode, 303);
    // Switching the trusted edge/Traefik address family must not reset a visitor.
    assert.equal((await f.post('2001:db8:1::10', f.headers('198.51.100.7', '198.18.0.99', '2001:db8:2::20'))).statusCode, 429);
    for (let index = 0; index < 5; index++) assert.equal((await f.post('2001:db8:1::10', f.headers('2001:db8:3::7', `198.18.1.${index}`, '2001:db8:2::20'))).statusCode, 303);
    assert.equal((await f.post('192.0.2.10', f.headers('2001:db8:3::7'))).statusCode, 429);
    assert.equal((await f.post('192.0.2.10', f.headers('2001:db8:3::8'))).statusCode, 303);
  });

  test('untrusted immediate peers and intermediary hops cannot claim trusted forwarded identities', async context => {
    const f = await fixture(context);
    for (let index = 0; index < 5; index++) assert.equal((await f.post('198.51.100.30', f.headers(`198.18.0.${index}`))).statusCode, 303);
    assert.equal((await f.post('198.51.100.30', f.headers('198.18.1.99'))).statusCode, 429);
    for (let index = 0; index < 5; index++) {
      assert.equal((await f.post('192.0.2.10', { ...f.headers(), 'x-forwarded-for': `198.18.0.${index}, 198.51.100.40, 203.0.113.10` })).statusCode, 303);
    }
    assert.equal((await f.post('192.0.2.10', { ...f.headers(), 'x-forwarded-for': '198.18.2.99, 198.51.100.40, 203.0.113.10' })).statusCode, 429);
  });

  test('proxied admin login, origin verification, secure cookies, export and logout keep their configured HTTPS behavior', async context => {
    const f = await fixture(context);
    const proxy = { remoteAddress: '192.0.2.10', headers: f.headers() };
    const page = await f.app.inject({ url: '/admin', ...proxy });
    const pending = cookieFrom(page.headers);
    assert.match(String(page.headers['set-cookie']), /__Host-osrs-jokes-admin=.*; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    const login = (visitor: string, key: string, origin = f.origin) => f.app.inject({ method: 'POST', url: '/admin/login', remoteAddress: proxy.remoteAddress,
      headers: { ...f.headers(visitor, randomUUID()), origin, cookie: pending }, payload: { key, csrf: csrfFrom(page.body) } });
    for (let index = 0; index < 5; index++) assert.equal((await login('198.51.100.7', 'wrong')).statusCode, 401);
    assert.equal((await login('198.51.100.7', f.key)).statusCode, 429);
    assert.equal((await login('198.51.100.8', f.key, 'https://evil.example')).statusCode, 403);
    const signedIn = await login('198.51.100.8', f.key);
    assert.equal(signedIn.statusCode, 303);
    assert.equal(signedIn.headers.location, '/admin');
    assert.match(String(signedIn.headers['set-cookie']), /; Secure;/);
    const cookie = cookieFrom(signedIn.headers);
    const dashboard = await f.app.inject({ url: '/admin/export', remoteAddress: proxy.remoteAddress, headers: { ...f.headers('198.51.100.8'), cookie } });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.headers['cache-control'], 'private, no-store');
    assert.ok(!dashboard.body.includes('http://evil.example'));
    const deck = await f.repository.createDeck('Proxied export');
    const authenticated = (url: string, payload: Record<string, unknown>) => f.app.inject({ method: 'POST', url, remoteAddress: proxy.remoteAddress,
      headers: { ...f.headers('198.51.100.8'), cookie, origin: f.origin }, payload: { ...payload, csrf: csrfFrom(dashboard.body) } });
    const download = await authenticated('/admin/export', { scope: 'selected', deckIds: deck.id });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['cache-control'], 'private, no-store');
    assert.equal(download.headers['content-disposition'], 'attachment; filename="decks.json"');
    assert.deepEqual(download.json(), { decks: [{ id: deck.id, name: 'Proxied export', jokes: [] }] });
    assert.equal((await authenticated('/admin/logout', {})).headers.location, '/admin');
    assert.equal((await authenticated('/admin/export', { scope: 'all' })).statusCode, 401);
  });

  test('dynamic responses stay uncacheable while only static assets allow a short shared cache lifetime', async context => {
    const f = await fixture(context);
    for (const url of ['/', '/?submitted=1', '/admin', '/admin/jokes', '/admin/export', '/health/ready']) {
      assert.match(String((await f.app.inject(url)).headers['cache-control']), /no-store/);
    }
    const submitted = await f.post('192.0.2.10', f.headers());
    assert.equal(submitted.headers['cache-control'], 'no-store');
    for (const url of ['/styles.css', '/submission.js', '/theme-picker.js', '/theme-editor.js', '/admin-selection.js']) {
      const response = await f.app.inject(url);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'public, max-age=300');
      assert.equal(response.headers['set-cookie'], undefined);
    }
  });
});
