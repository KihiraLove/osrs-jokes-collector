import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

describe('admin decks and selection', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => {
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
  });
  after(async () => { try { await maintenance?.end(); } finally { await database?.close(); } });
  const cookieFrom = (headers: Record<string, unknown>) => String(Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] : headers['set-cookie']).split(';')[0]!;
  const csrfFrom = (body: string) => body.match(/name="csrf" value="([a-f0-9]{64})"/)![1]!;
  const cardIds = (body: string) => [...body.matchAll(/data-joke-id="([a-f0-9-]+)"/g)].map(match => match[1]!);

  async function fixture(context: TestContext) {
    const schema = `deck_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const applications: FastifyInstance[] = [];
    const origin = 'https://jokes.example.com';
    let key = '';
    function openApp() {
      const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
      const repository = new JokeRepository(pool);
      const store = new AdminStore(pool);
      const app = createApp(databaseLifecycle(pool), false, { repository, store, settings: adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), onInitialKey: value => { key = value; } });
      applications.push(app);
      return { app, pool, repository, store };
    }
    context.after(async () => {
      try { await Promise.all(applications.map(app => app.close())); }
      finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    });
    const initial = openApp();
    async function login() {
      const page = await initial.app.inject('/admin');
      const response = await initial.app.inject({ method: 'POST', url: '/admin/login', headers: { origin, cookie: cookieFrom(page.headers) }, payload: { key, csrf: csrfFrom(page.body) } });
      assert.equal(response.statusCode, 303);
      const cookie = cookieFrom(response.headers);
      const csrf = csrfFrom((await initial.app.inject({ url: '/admin/jokes', headers: { cookie } })).body);
      return { cookie, csrf };
    }
    const { cookie, csrf } = await login();
    const get = (url: string) => initial.app.inject({ url, headers: { cookie } });
    const post = (url: string, fields: Record<string, unknown> = {}, json = false) => initial.app.inject({ method: 'POST', url,
      headers: { origin, cookie, ...(json ? { accept: 'application/json' } : {}) }, payload: { csrf, ...fields } });
    const select = (pageIds: string[], selectedIds = pageIds) => post('/admin/selection', { action: 'page', pageIds, selectedIds }, true);
    const selection = async () => (await get('/admin/selection')).json<{ ids: string[]; staleIds: string[] }>();
    return { ...initial, get, post, select, selection, openApp, login, cookie, csrf, origin };
  }

  test('deck CRUD normalizes unique names, preserves IDs and manages empty decks', async context => {
    const f = await fixture(context);
    assert.match((await f.get('/admin/decks')).body, /No decks yet/);
    assert.equal((await f.post('/admin/decks', { name: '  Ｇｉｅｌｉｎｏｒ   Jokes  ' })).statusCode, 303);
    const deck = (await f.repository.listDeckUsage())[0]!;
    assert.equal(deck.name, 'Gielinor Jokes');
    assert.equal(deck.jokeCount, 0);
    assert.equal((await f.post('/admin/decks', { name: 'gielinor jokes' })).statusCode, 409);
    assert.equal((await f.post('/admin/decks', { name: '\u0085\uFEFF' })).statusCode, 422);
    assert.equal((await f.post('/admin/decks', { name: 'x'.repeat(101) })).statusCode, 422);
    assert.equal((await f.post(`/admin/decks/${deck.id}/rename`, { name: '<script>Renamed</script>' })).statusCode, 303);
    assert.equal((await f.repository.getDeck(deck.id))!.name, '<script>Renamed</script>');
    const page = await f.get('/admin/decks');
    assert.match(page.body, /&lt;script&gt;Renamed&lt;\/script&gt;/);
    assert.ok(page.body.includes(deck.id));
    assert.ok(!page.body.includes('<script>Renamed'));
    assert.equal((await f.get(`/admin/decks/${deck.id}/delete`)).statusCode, 200);
    assert.equal((await f.post(`/admin/decks/${deck.id}/delete`)).statusCode, 422);
    assert.equal((await f.post(`/admin/decks/${deck.id}/delete`, { confirmation: 'delete', expectedUsage: '0' })).statusCode, 303);
    assert.equal(await f.repository.getDeck(deck.id), null);
    assert.equal((await f.get(`/admin/decks/${deck.id}/rename`)).statusCode, 404);
  });

  test('selection persists across themes, pages and app instances and counts shared jokes once', async context => {
    const f = await fixture(context);
    const a = await f.repository.submit({ kind: 'single', text: 'A only', themes: ['A'] });
    const both = await f.repository.submit({ kind: 'single', text: 'A and B', themes: ['A', 'B'] });
    const b = await f.repository.submit({ kind: 'single', text: 'B only', themes: ['B'] });
    assert.equal((await f.select([a.id, both.id])).statusCode, 200);
    const themeB = b.themes[0]!.id;
    const pageB = await f.get(`/admin/jokes?theme=${themeB}`);
    assert.match(pageB.headers['content-security-policy']!, /connect-src 'self'/);
    assert.match(pageB.body, /2 selected\. 1 hidden/);
    assert.ok(pageB.body.includes(`value="${both.id}" checked`));
    await f.select([both.id, b.id], [both.id, b.id]);
    assert.deepEqual(new Set((await f.selection()).ids), new Set([a.id, b.id, both.id]));
    await f.pool.query("INSERT INTO jokes (kind, text) SELECT 'single', 'Page ' || i FROM generate_series(1, 30) i");
    const newest = await f.get('/admin/jokes');
    const nextUrl = newest.body.match(/rel="next" href="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
    const older = await f.get(nextUrl);
    assert.equal(cardIds(older.body).length, 8);
    assert.match(older.body, /3 selected/);
    assert.ok(older.body.includes(`value="${a.id}" checked`));
    const nextApp = f.openApp();
    const restored = await nextApp.app.inject({ url: '/admin/selection', headers: { cookie: f.cookie } });
    assert.deepEqual(new Set(restored.json().ids), new Set([a.id, b.id, both.id]));
    const visible = cardIds(newest.body);
    const selectedPage = await f.post('/admin/selection', { action: 'all', pageIds: visible }, true);
    assert.equal(selectedPage.json().ids.length, 28, 'Select current page must not select the other unselected rows.');
    await f.post('/admin/selection', { action: 'clear' }, true);
    assert.deepEqual((await f.selection()).ids, []);
  });

  test('bulk create, move and unassign affect the whole explicit selection atomically', async context => {
    const f = await fixture(context);
    const a = await f.repository.submit({ kind: 'single', text: 'Keep A', themes: ['A'] });
    const b = await f.repository.submit({ kind: 'two_part', text: 'Keep B', punchline: 'Keep answer', themes: ['B'] });
    const ids = [a.id, b.id];
    await f.select(ids);
    const created = await f.post('/admin/assign', { target: 'new', name: 'First deck', expectedIds: ids });
    assert.equal(created.statusCode, 303);
    assert.match(created.headers.location!, /count=2&changed=2&moved=0/);
    const first = (await f.repository.listDeckUsage())[0]!;
    assert.equal(first.jokeCount, 2);
    assert.deepEqual((await f.selection()).ids, []);
    const second = await f.repository.createDeck('Second deck');
    await f.select(ids);
    const moved = await f.post('/admin/assign', { target: second.id, expectedIds: ids, name: { ignored: true } });
    assert.equal(moved.statusCode, 303);
    assert.match(moved.headers.location!, /count=2&changed=2&moved=2/);
    for (const id of ids) assert.equal((await f.repository.getJoke(id))!.deckId, second.id);
    assert.equal((await f.repository.getDeck(first.id))!.jokeCount, 0);
    await f.select(ids);
    const same = await f.post('/admin/assign', { target: second.id.toUpperCase(), expectedIds: ids });
    assert.match(same.headers.location!, /changed=0&moved=0/);
    await f.select(ids);
    const removed = await f.post('/admin/assign', { target: 'none', expectedIds: ids });
    assert.equal(removed.statusCode, 303);
    assert.match((await f.get(removed.headers.location!)).body, /Removed deck assignments from 2 of 2/);
    assert.equal((await f.repository.getJoke(a.id))!.deckId, null);
    assert.equal((await f.repository.getJoke(b.id))!.punchline, 'Keep answer');
    assert.equal((await f.repository.getJoke(b.id))!.themes[0]!.name, 'B');
    assert.equal((await f.repository.getDeck(second.id))!.jokeCount, 0);
  });

  test('stale jokes and targets produce conflicts without partial assignments and can be reconciled', async context => {
    const f = await fixture(context);
    const a = await f.repository.submit({ kind: 'single', text: 'Deleted later' });
    const b = await f.repository.submit({ kind: 'single', text: 'Preserved' });
    const deck = await f.repository.createDeck('Target');
    await f.select([a.id, b.id]);
    await f.repository.deleteJoke(a.id);
    const conflict = await f.post('/admin/assign', { target: deck.id, expectedIds: [a.id, b.id] });
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.body, /Some selected jokes were deleted/);
    assert.equal((await f.repository.getJoke(b.id))!.deckId, null);
    assert.deepEqual((await f.selection()).staleIds, [a.id]);
    await f.post('/admin/selection', { action: 'prune' }, true);
    assert.deepEqual((await f.selection()).ids, [b.id]);
    await f.repository.deleteDeck(deck.id);
    const missing = await f.post('/admin/assign', { target: deck.id, expectedIds: [b.id], deck: deck.id });
    assert.equal(missing.statusCode, 409);
    assert.match(missing.body, /selected deck no longer exists/);
    assert.deepEqual((await f.selection()).ids, [b.id]);
    assert.equal((await f.post('/admin/assign', { target: 'new', name: 'Recovered', expectedIds: [b.id] })).statusCode, 303);
  });

  test('new deck and selection writes roll back on failures; duplicate names and changed selections remain usable', async context => {
    const f = await fixture(context);
    const a = await f.repository.submit({ kind: 'single', text: 'A' });
    const b = await f.repository.submit({ kind: 'single', text: 'B' });
    await f.select([a.id]);
    await f.pool.query("CREATE FUNCTION reject_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private move failure'; END $$; CREATE TRIGGER reject_move BEFORE UPDATE ON jokes FOR EACH ROW EXECUTE FUNCTION reject_move()");
    assert.equal((await f.post('/admin/assign', { target: 'new', name: 'Rolled back', expectedIds: [a.id] })).statusCode, 500);
    assert.equal((await f.repository.listDeckUsage()).length, 0);
    assert.deepEqual((await f.selection()).ids, [a.id]);
    await f.pool.query('DROP TRIGGER reject_move ON jokes');
    const deck = await f.repository.createDeck('Existing');
    const duplicate = await f.post('/admin/assign', { target: 'new', name: ' EXISTING ', expectedIds: [a.id] });
    assert.equal(duplicate.statusCode, 409);
    assert.match(duplicate.body, /value=" EXISTING "/);
    assert.deepEqual((await f.selection()).ids, [a.id]);
    await f.select([b.id]);
    const changed = await f.post('/admin/assign', { target: deck.id, expectedIds: [a.id] });
    assert.equal(changed.statusCode, 409);
    assert.match(changed.body, /selection changed in another tab/);
    assert.equal((await f.repository.getDeck(deck.id))!.jokeCount, 0);
    assert.equal((await f.post('/admin/assign', { target: deck.id, expectedIds: [a.id, b.id] })).statusCode, 303);
  });

  test('selection validates IDs, explicit pages and the 500 joke bound without partial writes', async context => {
    const f = await fixture(context);
    const rows = await f.pool.query<{ id: string }>("INSERT INTO jokes (kind, text) SELECT 'single', 'Bound ' || i FROM generate_series(1, 501) i RETURNING id");
    const ids = rows.rows.map(row => row.id);
    assert.equal((await f.select([ids[0]!], [ids[1]!])).statusCode, 422);
    assert.equal((await f.select(['invalid'])).statusCode, 422);
    assert.deepEqual((await f.selection()).ids, []);
    for (let index = 0; index < 5; index++) assert.equal((await f.select(ids.slice(index * 100, (index + 1) * 100))).statusCode, 200);
    assert.equal((await f.select([ids[500]!])).statusCode, 422);
    assert.equal((await f.selection()).ids.length, 500);
    assert.equal((await f.select([randomUUID()])).statusCode, 409);
    assert.equal((await f.selection()).ids.length, 500);
    const other = await f.login();
    assert.deepEqual((await f.app.inject({ url: '/admin/selection', headers: { cookie: other.cookie } })).json().ids, []);
    await f.post('/admin/logout');
    assert.equal((await f.pool.query('SELECT * FROM admin_joke_selection')).rowCount, 0);
  });

  test('populated deck deletion confirms counts and preserves joke text/themes; deck filters show membership', async context => {
    const f = await fixture(context);
    const joke = await f.repository.submit({ kind: 'two_part', text: 'Preserved setup', punchline: 'Preserved answer', themes: ['Preserved theme'] });
    const deck = await f.repository.createDeckWithJokes('Populated', [joke.id]);
    const empty = await f.repository.createDeck('Empty');
    assert.deepEqual(cardIds((await f.get(`/admin/jokes?deck=${deck.id}`)).body), [joke.id]);
    assert.deepEqual(cardIds((await f.get(`/admin/jokes?deck=${empty.id}`)).body), []);
    assert.match((await f.get(`/admin/decks/${deck.id}/delete`)).body, /1 joke will become unassigned/);
    await f.repository.submit({ kind: 'single', text: 'Other' });
    const other = (await f.repository.list()).find(row => row.text === 'Other')!;
    await f.repository.assignDeck([other.id], deck.id);
    const changed = await f.post(`/admin/decks/${deck.id}/delete`, { confirmation: 'delete', expectedUsage: '1' });
    assert.equal(changed.statusCode, 409);
    assert.match(changed.body, /Deck membership changed/);
    assert.equal((await f.post(`/admin/decks/${deck.id}/delete`, { confirmation: 'delete', expectedUsage: '2' })).statusCode, 303);
    const preserved = await f.repository.getJoke(joke.id);
    assert.equal(preserved!.punchline, 'Preserved answer');
    assert.equal(preserved!.themes[0]!.name, 'Preserved theme');
    assert.equal(preserved!.deckId, null);
    assert.equal((await f.get(`/admin/jokes?deck=${deck.id}`)).statusCode, 404);
  });

  test('deck and selection routes reject anonymous, CSRF-invalid and cross-origin mutations', async context => {
    const f = await fixture(context);
    const deck = await f.repository.createDeck('Protected');
    for (const url of ['/admin/decks', '/admin/selection', `/admin/decks/${deck.id}/rename`, `/admin/decks/${deck.id}/delete`]) assert.equal((await f.app.inject(url)).statusCode, 401);
    for (const url of ['/admin/decks', '/admin/selection', '/admin/assign', `/admin/decks/${deck.id}/rename`, `/admin/decks/${deck.id}/delete`]) {
      assert.equal((await f.app.inject({ method: 'POST', url, payload: { name: 'Unauthorized' } })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: f.cookie, origin: f.origin }, payload: { name: 'Unauthorized' } })).statusCode, 403);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: f.cookie, origin: 'https://evil.example' }, payload: { csrf: f.csrf, name: 'Unauthorized' } })).statusCode, 403);
    }
    assert.equal((await f.repository.getDeck(deck.id))!.name, 'Protected');
    assert.equal((await f.get('/admin/decks/invalid/delete')).statusCode, 400);
    assert.equal((await f.post('/admin/selection', { action: { invalid: true } }, true)).statusCode, 422);
  });
});
