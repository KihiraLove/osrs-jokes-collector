import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyServerOptions } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { SubmissionLimiter } from '../src/submissions/limiter.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

describe('admin moderation', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => {
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
  });
  after(async () => {
    try { await maintenance?.end(); } finally { await database?.close(); }
  });
  const ids = (body: string) => [...body.matchAll(/data-joke-id="([a-f0-9-]+)"/g)].map(match => match[1]!);
  const cookieFrom = (headers: Record<string, unknown>) => String(Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] : headers['set-cookie']).split(';')[0]!;
  const csrfFrom = (body: string) => body.match(/name="csrf" value="([a-f0-9]{64})"/)![1]!;

  async function fixture(context: TestContext, logger: FastifyServerOptions['logger'] = false) {
    const schema = `moderation_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
    const repository = new JokeRepository(pool);
    const origin = 'https://jokes.example.com';
    let initialKey = '';
    const app = createApp(databaseLifecycle(pool), logger, {
      settings: adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), store: new AdminStore(pool), repository,
      onInitialKey: key => { initialKey = key; },
    }, { repository, limiter: new SubmissionLimiter(pool) });
    context.after(async () => {
      try { await app.close(); } finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    });
    const login = await app.inject('/admin');
    const authenticated = await app.inject({ method: 'POST', url: '/admin/login', headers: { origin, cookie: cookieFrom(login.headers) }, payload: { key: initialKey, csrf: csrfFrom(login.body) } });
    assert.equal(authenticated.statusCode, 303);
    const cookie = cookieFrom(authenticated.headers);
    const get = (url: string) => app.inject({ url, headers: { cookie } });
    const csrf = csrfFrom((await get('/admin/jokes')).body);
    function post(url: string, fields: Record<string, string | string[]> = {}) {
      const data = new URLSearchParams({ csrf });
      for (const [name, value] of Object.entries(fields)) for (const entry of Array.isArray(value) ? value : [value]) data.append(name, entry);
      return app.inject({ method: 'POST', url, headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: data.toString() });
    }
    return { app, pool, repository, get, post, cookie, csrf, origin, initialKey };
  }

  test('admin browsing shows full escaped joke parts, deck/time and all theme filters without duplicates', async context => {
    const f = await fixture(context);
    const multi = await f.repository.submit({ kind: 'single', text: '<script>joke()</script>\nSecond line', themes: ['A', 'B'] });
    const two = await f.repository.submit({ kind: 'two_part', text: 'The setup?\nStill setup.', punchline: '<b>A punchline</b>', themes: ['A'] });
    const bare = await f.repository.submit({ kind: 'single', text: 'Without a theme' });
    const deck = await f.repository.createDeckWithJokes('<img src=x> Deck', [multi.id]);
    await f.pool.query("INSERT INTO themes (name, normalized_name) VALUES ('Unused', 'unused')");
    const themes = await f.repository.listThemes();
    const a = themes.find(theme => theme.name === 'A')!;
    const b = themes.find(theme => theme.name === 'B')!;
    const unused = themes.find(theme => theme.name === 'Unused')!;
    const page = await f.get('/admin/jokes');
    assert.deepEqual(new Set(ids(page.body)), new Set([multi.id, two.id, bare.id]));
    assert.match(page.body, /Unused \(0\)/);
    assert.match(page.body, /&lt;script&gt;joke\(\)&lt;\/script&gt;\nSecond line/);
    assert.match(page.body, /<h3>Setup<\/h3>.*The setup\?\nStill setup\./s);
    assert.match(page.body, /&lt;b&gt;A punchline&lt;\/b&gt;/);
    assert.match(page.body, /Deck: &lt;img src=x&gt; Deck/);
    assert.match(page.body, /<time datetime="\d{4}-/);
    assert.ok(!page.body.includes('<script>joke()'));
    assert.ok(!page.body.includes(f.initialKey));
    assert.ok(!page.body.includes(f.cookie.split('=')[1]!));
    assert.equal(page.headers['cache-control'], 'private, no-store');
    assert.deepEqual(new Set(ids((await f.get(`/admin/jokes?theme=${a.id}`)).body)), new Set([multi.id, two.id]));
    assert.deepEqual(ids((await f.get(`/admin/jokes?theme=${b.id.toUpperCase()}`)).body), [multi.id]);
    assert.deepEqual(ids((await f.get('/admin/jokes?theme=none&deck=unassigned')).body), [bare.id]);
    assert.deepEqual(new Set(ids((await f.get('/admin/jokes?deck=unassigned')).body)), new Set([two.id, bare.id]));
    const empty = await f.get(`/admin/jokes?theme=${unused.id}`);
    assert.equal(empty.statusCode, 200);
    assert.match(empty.body, /No jokes match/);
    assert.equal((await f.repository.getJoke(multi.id))!.deckId, deck.id);
  });

  test('admin pagination reaches every microsecond-ordered joke across concurrent inserts and deletions', async context => {
    const f = await fixture(context);
    await f.pool.query("INSERT INTO themes (name, normalized_name) VALUES ('Pagination', 'pagination')");
    const theme = (await f.repository.listThemes())[0]!;
    await f.pool.query("INSERT INTO jokes (kind, text, created_at) SELECT 'single', 'Page joke ' || i, '2026-01-01 00:00:00 UTC'::timestamptz + i * INTERVAL '1 microsecond' FROM generate_series(1, 58) i");
    await f.pool.query('INSERT INTO joke_themes (joke_id, theme_id) SELECT id, $1 FROM jokes', [theme.id]);
    const original = new Set((await f.repository.list({ limit: 100 })).map(joke => joke.id));
    let page = await f.get(`/admin/jokes?theme=${theme.id}&deck=unassigned`);
    const seen = ids(page.body);
    assert.equal(seen.length, 25);
    await f.repository.submit({ kind: 'single', text: 'Newer during pagination', themes: ['Pagination'] });
    await f.repository.deleteJoke(seen[0]!);
    for (let index = 0; index < 2; index++) {
      const next = page.body.match(/rel="next" href="([^"]+)"/);
      assert.ok(next, 'Every older page must remain reachable.');
      const url = next[1]!.replaceAll('&amp;', '&');
      assert.match(url, new RegExp(`theme=${theme.id}&deck=unassigned&before=`));
      page = await f.get(url);
      assert.equal(page.statusCode, 200);
      seen.push(...ids(page.body));
    }
    assert.equal(new Set(seen).size, 58);
    assert.deepEqual(new Set(seen), original);
    assert.ok(!page.body.includes('rel="next"'));
    assert.match(page.body, /Newest page/);
    assert.ok(!page.body.includes('Newer during pagination'));
    assert.match((await f.get(`/admin/jokes?theme=${theme.id}&deck=unassigned`)).body, /Newer during pagination/);
  });

  test('admin moderation routes require authentication, origin/CSRF and explicit deletion confirmation', async context => {
    const f = await fixture(context);
    const joke = await f.repository.submit({ kind: 'single', text: 'Protected joke', themes: ['Protected theme'] });
    const theme = joke.themes[0]!;
    for (const url of ['/admin/jokes', '/admin/themes', `/admin/jokes/${joke.id}/themes`, `/admin/jokes/${joke.id}/delete`, `/admin/themes/${theme.id}/delete`]) {
      assert.equal((await f.app.inject(url)).statusCode, 401);
    }
    for (const url of [`/admin/jokes/${joke.id}/themes`, `/admin/jokes/${joke.id}/delete`, `/admin/themes/${theme.id}/delete`]) {
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { origin: f.origin }, payload: { csrf: f.csrf, confirmation: 'delete', expectedUsage: '1' } })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: f.cookie, origin: f.origin }, payload: { confirmation: 'delete', expectedUsage: '1' } })).statusCode, 403);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: f.cookie, origin: 'https://evil.example' }, payload: { csrf: f.csrf, confirmation: 'delete', expectedUsage: '1' } })).statusCode, 403);
    }
    await f.get(`/admin/jokes/${joke.id}/delete`);
    await f.get(`/admin/themes/${theme.id}/delete`);
    assert.ok(await f.repository.getJoke(joke.id), 'GET confirmation pages must not mutate records.');
    assert.equal((await f.post(`/admin/jokes/${joke.id}/delete`)).statusCode, 422);
    assert.equal((await f.post(`/admin/themes/${theme.id}/delete`, { expectedUsage: '1' })).statusCode, 422);
    assert.ok(await f.repository.getTheme(theme.id));
    assert.ok(!(await f.app.inject('/')).body.includes('Protected joke'));
    assert.equal((await f.get('/admin')).headers.location, '/admin/jokes');
  });

  test('admin joke deletion removes membership and links while preserving decks and themes', async context => {
    const f = await fixture(context);
    const joke = await f.repository.submit({ kind: 'two_part', text: 'Delete setup', punchline: 'Delete answer', themes: ['Keep A', 'Keep B'] });
    const deck = await f.repository.createDeckWithJokes('Keep deck', [joke.id]);
    const theme = joke.themes[0]!;
    const confirm = await f.get(`/admin/jokes/${joke.id}/delete?theme=${theme.id}`);
    assert.match(confirm.body, /Delete this joke\?/);
    assert.match(confirm.body, /Delete setup/);
    assert.match(confirm.body, /Delete answer/);
    const response = await f.post(`/admin/jokes/${joke.id}/delete`, { confirmation: 'delete', theme: theme.id });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/admin/jokes?theme=${theme.id}&notice=joke-deleted`);
    assert.match((await f.get(response.headers.location!)).body, /The joke was deleted/);
    assert.equal(await f.repository.getJoke(joke.id), null);
    assert.equal((await f.pool.query('SELECT * FROM joke_themes')).rowCount, 0);
    assert.equal((await f.repository.listThemes()).length, 2);
    assert.equal((await f.repository.readDecks([deck.id]))[0]!.jokes.length, 0);
    assert.equal((await f.post(`/admin/jokes/${joke.id}/delete`, { confirmation: 'delete' })).statusCode, 404);
    assert.equal((await f.get(`/admin/jokes/${joke.id}/themes`)).statusCode, 404);
  });

  test('admin theme deletion confirms current usage, rejects changed counts and preserves jokes/decks', async context => {
    const f = await fixture(context);
    const first = await f.repository.submit({ kind: 'single', text: 'First preserved', themes: ['Remove theme', 'Keep theme'] });
    const second = await f.repository.submit({ kind: 'two_part', text: 'Preserved setup', punchline: 'Preserved answer', themes: ['Remove theme'] });
    const deck = await f.repository.createDeckWithJokes('Preserved deck', [first.id, second.id]);
    const theme = first.themes.find(theme => theme.name === 'Remove theme')!;
    const confirm = await f.get(`/admin/themes/${theme.id}/delete`);
    assert.match(confirm.body, /2 joke associations/);
    assert.match(confirm.body, /name="expectedUsage" value="2"/);
    await f.repository.submit({ kind: 'single', text: 'Arrived after confirmation', themes: ['Remove theme'] });
    const conflict = await f.post(`/admin/themes/${theme.id}/delete`, { confirmation: 'delete', expectedUsage: '2' });
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.body, /Theme usage changed/);
    assert.match(conflict.body, /3 joke associations/);
    assert.match(conflict.body, /name="expectedUsage" value="3"/);
    const deleted = await f.post(`/admin/themes/${theme.id}/delete`, { confirmation: 'delete', expectedUsage: '3' });
    assert.equal(deleted.statusCode, 303);
    const preserved = await f.repository.getJoke(first.id);
    assert.equal(preserved!.text, 'First preserved');
    assert.equal(preserved!.deckId, deck.id);
    assert.deepEqual(preserved!.themes.map(theme => theme.name), ['Keep theme']);
    assert.equal((await f.repository.getJoke(second.id))!.punchline, 'Preserved answer');
    assert.equal((await f.repository.readDecks([deck.id]))[0]!.jokes.length, 2);
    assert.equal(await f.repository.getTheme(theme.id), null);
    for (const page of [await f.get('/admin/jokes'), await f.get(`/admin/jokes/${first.id}/themes`), await f.app.inject('/')]) assert.ok(!page.body.includes('value="Remove theme"'));
    assert.equal((await f.get(`/admin/jokes?theme=${theme.id}`)).statusCode, 404);
    assert.equal((await f.post(`/admin/themes/${theme.id}/delete`, { confirmation: 'delete', expectedUsage: '0' })).statusCode, 404);
  });

  test('admin theme editing reuses normalized themes, retains errors and can remove the final association', async context => {
    const f = await fixture(context);
    const joke = await f.repository.submit({ kind: 'single', text: 'Keep this text', themes: ['PvM', 'Skilling'] });
    const deck = await f.repository.createDeckWithJokes('Keep assignment', [joke.id]);
    const edit = await f.get(`/admin/jokes/${joke.id}/themes`);
    assert.match(edit.body, /type="module" src="\/theme-editor.js"/);
    assert.match(edit.body, /value="PvM" checked/);
    const failed = await f.post(`/admin/jokes/${joke.id}/themes`, { themes: ['PvM'], newThemes: '<script>' + 'x'.repeat(81) });
    assert.equal(failed.statusCode, 422);
    assert.match(failed.body, /value="PvM" checked/);
    assert.match(failed.body, /&lt;script&gt;/);
    assert.equal((await f.repository.listThemes()).length, 2);
    const saved = await f.post(`/admin/jokes/${joke.id}/themes`, { themes: [' ＰｖＭ ', 'SKILLING'], newThemes: 'PvM\nNew  theme', theme: joke.themes[0]!.id, returnTo: 'https://evil.example/' });
    assert.equal(saved.statusCode, 303);
    assert.match(saved.headers.location!, /^\/admin\/jokes\?theme=/);
    assert.deepEqual((await f.repository.getJoke(joke.id))!.themes.map(theme => theme.name), ['New theme', 'PvM', 'Skilling']);
    assert.equal((await f.repository.getJoke(joke.id))!.deckId, deck.id);
    assert.equal((await f.post(`/admin/jokes/${joke.id}/themes`)).statusCode, 303);
    const unthemed = await f.repository.getJoke(joke.id);
    assert.deepEqual(unthemed!.themes, []);
    assert.equal(unthemed!.text, 'Keep this text');
    assert.equal(unthemed!.deckId, deck.id);
    assert.deepEqual(ids((await f.get('/admin/jokes?theme=none')).body), [joke.id]);
    assert.ok((await f.repository.listThemeUsage()).every(theme => theme.jokeCount === 0));
    const emptyTheme = (await f.repository.listThemes())[0]!;
    assert.equal((await f.post(`/admin/themes/${emptyTheme.id}/delete`, { confirmation: 'delete', expectedUsage: '0' })).statusCode, 303);
    assert.equal((await f.post(`/admin/jokes/${randomUUID()}/themes`, { newThemes: 'Must not be created' })).statusCode, 404);
    assert.ok(!(await f.repository.listThemes()).some(theme => theme.name === 'Must not be created'));
  });

  test('admin empty, invalid filter/cursor and stale record states have useful feedback', async context => {
    const f = await fixture(context);
    assert.match((await f.get('/admin/jokes')).body, /No jokes have been collected/);
    assert.match((await f.get('/admin/themes')).body, /No themes have been created/);
    const invalid = [
      '/admin/jokes?theme=invalid', '/admin/jokes?deck=invalid', '/admin/jokes?theme=all&theme=none', '/admin/jokes?before=invalid',
      `/admin/jokes?before=${Buffer.from(JSON.stringify(['2026-02-30T00:00:00.000001Z', randomUUID()])).toString('base64url')}`,
      `/admin/jokes?before=${Buffer.from(JSON.stringify(['0000-01-01T00:00:00.000001Z', randomUUID()])).toString('base64url')}`,
    ];
    for (const url of invalid) {
      const response = await f.get(url);
      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Return to newest jokes/);
    }
    assert.equal((await f.get(`/admin/jokes/${randomUUID()}/delete`)).statusCode, 404);
    assert.equal((await f.get(`/admin/themes/${randomUUID()}/delete`)).statusCode, 404);
    assert.equal((await f.get('/admin/jokes/invalid/themes')).statusCode, 400);
  });

  test('admin database read/write failures give safe feedback and leave records intact', async context => {
    let logs = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
    const f = await fixture(context, { stream });
    const joke = await f.repository.submit({ kind: 'single', text: 'Preserve on failure' });
    await f.pool.query("CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database detail'; END $$; CREATE TRIGGER reject_delete BEFORE DELETE ON jokes FOR EACH ROW EXECUTE FUNCTION reject_delete()");
    const failed = await f.post(`/admin/jokes/${joke.id}/delete`, { confirmation: 'delete' });
    assert.equal(failed.statusCode, 500);
    assert.match(failed.body, /Admin data is temporarily unavailable/);
    assert.ok(await f.repository.getJoke(joke.id));
    await f.pool.query('ALTER TABLE jokes RENAME TO temporarily_unavailable');
    try { assert.equal((await f.get('/admin/jokes')).statusCode, 500); }
    finally { await f.pool.query('ALTER TABLE temporarily_unavailable RENAME TO jokes'); }
    assert.equal((await f.get('/admin/jokes')).statusCode, 200);
    for (const secret of ['private database detail', f.initialKey, f.cookie.split('=')[1]!, f.csrf]) assert.ok(!logs.includes(secret));
    assert.ok(!failed.body.includes('private database detail'));
  });
});
