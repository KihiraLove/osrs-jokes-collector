import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { SubmissionLimiter } from '../src/submissions/limiter.ts';
import { SUBMISSION_BODY_LIMIT } from '../src/submissions/routes.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

describe('public submissions', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => {
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
  });
  after(async () => {
    try { await maintenance?.end(); } finally { await database?.close(); }
  });

  async function fixture(context: TestContext, logger: FastifyServerOptions['logger'] = false, trustedProxies = '') {
    const schema = `submission_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const applications: FastifyInstance[] = [];
    function openApp() {
      const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
      const repository = new JokeRepository(pool);
      const limiter = new SubmissionLimiter(pool);
      const app = createApp(databaseLifecycle(pool), logger, {
        store: new AdminStore(pool), settings: adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://jokes.example.com', TRUSTED_PROXY_CIDRS: trustedProxies }),
        onInitialKey: () => {}, routes: admin => { admin.get('/export', async () => ({ decks: [] })); },
      }, { repository, limiter });
      applications.push(app);
      return { app, pool, repository, limiter };
    }
    context.after(async () => {
      try { await Promise.all(applications.map(app => app.close())); }
      finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    });
    const initial = openApp();
    await initial.app.ready();
    let address = 0;
    function post(body: Record<string, string | string[]>, remoteAddress = `198.51.100.${++address}`, extraHeaders = {}) {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(body)) for (const entry of Array.isArray(value) ? value : [value]) params.append(name, entry);
      return initial.app.inject({ method: 'POST', url: '/', remoteAddress, headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, payload: params.toString() });
    }
    return { ...initial, openApp, post };
  }

  test('public form renders every theme, escapes names and refreshes additions/deletions', async context => {
    const f = await fixture(context);
    await f.pool.query("INSERT INTO themes (name, normalized_name) SELECT 'Theme ' || i, 'theme ' || i FROM generate_series(1, 150) AS i");
    await f.repository.submit({ kind: 'single', text: 'Private collected joke', themes: ['<script> & "Quotes"'] });
    const page = await f.app.inject('/');
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.body, /name="kind" value="single" checked/);
    assert.match(page.body, /id="punchline-field" class="field" hidden/);
    assert.match(page.body, /Choose from all existing themes \(151\)/);
    assert.equal((page.body.match(/type="checkbox" name="themes"/g) ?? []).length, 151);
    assert.ok(!page.body.includes('Private collected joke'));
    assert.ok(!page.body.includes('<script> &'));
    assert.match(page.body, /&lt;script&gt; &amp; &quot;Quotes&quot;/);
    const doomed = (await f.repository.listThemes()).find(theme => theme.name === 'Theme 150')!;
    await f.repository.deleteTheme(doomed.id);
    await f.repository.submit({ kind: 'single', text: 'Another private joke', themes: ['New arrival'] });
    const refreshed = await f.app.inject('/');
    assert.ok(!refreshed.body.includes('value="Theme 150"'));
    assert.match(refreshed.body, /value="New arrival"/);
    assert.equal((await f.app.inject('/submission.js')).statusCode, 200);
  });

  test('public single/two part submissions save no/one/mixed themes and start without a deck', async context => {
    const f = await fixture(context);
    for (const body of [
      { kind: 'single', text: '  A single\nline break.  ' },
      { kind: 'single', text: 'One theme', newThemes: 'Skilling' },
      { kind: 'two_part', text: '\u00a0A setup?\n\nAnother line. ', punchline: '  The punchline!\uFEFF', themes: ['Skilling'], newThemes: 'PvM\n Gielinor ' },
    ]) {
      const response = await f.post(body);
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/?submitted=1');
    }
    const rows = await f.repository.list();
    assert.equal(rows.length, 3);
    assert.ok(rows.every(joke => joke.deckId === null));
    assert.equal(rows.find(joke => joke.text.startsWith('A single'))!.themes.length, 0);
    assert.equal(rows.find(joke => joke.text === 'One theme')!.themes.length, 1);
    const twoPart = rows.find(joke => joke.kind === 'two_part')!;
    assert.equal(twoPart.text, 'A setup?\n\nAnother line.');
    assert.equal(twoPart.punchline, 'The punchline!');
    assert.deepEqual(twoPart.themes.map(theme => theme.name), ['Gielinor', 'PvM', 'Skilling']);
    assert.match((await f.app.inject('/?submitted=1')).body, /Thanks — your joke was submitted/);
  });

  test('public validation retains drafts and selections and only validates active joke fields', async context => {
    const f = await fixture(context);
    await f.repository.submit({ kind: 'single', text: 'Seed', themes: ['PvM'] });
    const failed = await f.post({ kind: 'two_part', text: 'Draft </textarea><script>bad()</script>', punchline: ' ', themes: ['PvM'], newThemes: 'New theme' });
    assert.equal(failed.statusCode, 422);
    assert.match(failed.body, /Joke parts must contain/);
    assert.match(failed.body, /Draft &lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(failed.body, /value="PvM" checked/);
    assert.match(failed.body, />New theme<\/textarea>/);
    assert.match(failed.body, /name="kind" value="two_part" checked/);
    assert.match(failed.body, /name="punchline"[^>]* required/);
    assert.equal((await f.repository.list()).length, 1);
    const inactive = await f.app.inject({ method: 'POST', url: '/', payload: { kind: 'single', text: 'Active field', punchline: { ignored: true }, deckId: randomUUID() } });
    assert.equal(inactive.statusCode, 303);
    const single = (await f.repository.list()).find(joke => joke.text === 'Active field')!;
    assert.equal(single.punchline, null);
    assert.equal(single.deckId, null);
    const preview = await f.post({ intent: 'preview', kind: 'two_part', text: 'Unfinished setup', newThemes: 'Draft theme' });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.body, /name="punchline"[^>]* required/);
    assert.equal((await f.repository.list()).length, 2, 'The non-JavaScript type update must not submit a joke.');
  });

  test('public validation enforces character/theme/body bounds including percent-encoded Unicode', async context => {
    const f = await fixture(context);
    const unicode = await f.post({ kind: 'two_part', text: '😀'.repeat(4_000), punchline: '🦀'.repeat(4_000) });
    assert.equal(unicode.statusCode, 303, 'The encoded body bound must allow valid astral Unicode.');
    for (const body of [
      { kind: 'single', text: '\u0085\uFEFF' },
      { kind: 'single', text: 'a'.repeat(4_001) },
      { kind: 'two_part', text: 'Setup', punchline: '' },
      { kind: 'single', text: 'Bad theme', newThemes: 'a'.repeat(81) },
      { kind: 'single', text: 'Too many themes', themes: Array.from({ length: 11 }, (_, i) => `Theme ${i}`) },
      { kind: 'unknown', text: 'Bad type' },
    ]) assert.equal((await f.post(body)).statusCode, 422);
    const malformed = await f.app.inject({ method: 'POST', url: '/', payload: { kind: 'single', text: 'No object themes', themes: [{ name: 'Bad' }] } });
    assert.equal(malformed.statusCode, 422);
    const oversized = await f.app.inject({ method: 'POST', url: '/', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `kind=single&text=${'x'.repeat(SUBMISSION_BODY_LIMIT)}` });
    assert.equal(oversized.statusCode, 413);
    assert.match(oversized.body, /This request is too large/);
    assert.equal((await f.repository.list()).length, 1);
  });

  test('public concurrent equivalent themes converge and duplicate selections count once', async context => {
    const f = await fixture(context);
    const results = await Promise.all([
      f.post({ kind: 'single', text: 'First', newThemes: '  ＰｖＭ\u0085Jokes  ' }),
      f.post({ kind: 'single', text: 'Second', themes: ['pvm jokes'], newThemes: ' PVM  JOKES\npvm jokes' }),
    ]);
    assert.ok(results.every(response => response.statusCode === 303));
    assert.equal((await f.repository.listThemes()).length, 1);
    const jokes = await f.repository.list();
    assert.equal(jokes.length, 2);
    assert.equal(jokes[0]!.themes[0]!.id, jokes[1]!.themes[0]!.id);
    assert.equal((await f.pool.query('SELECT * FROM joke_themes')).rowCount, 2);
  });

  test('public transaction failures roll back new themes and jokes without logging submitted content', async context => {
    let logs = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
    const f = await fixture(context, { stream });
    await f.pool.query("CREATE FUNCTION reject_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database diagnostic'; END $$; CREATE TRIGGER reject_link BEFORE INSERT ON joke_themes FOR EACH ROW EXECUTE FUNCTION reject_link()");
    const response = await f.post({ kind: 'single', text: 'Retained private draft', newThemes: 'Rolled back theme' });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /Your joke could not be saved/);
    assert.match(response.body, /Retained private draft/);
    assert.match(response.body, /Rolled back theme/);
    assert.ok(!response.body.includes('private database diagnostic'));
    assert.equal((await f.repository.list()).length, 0);
    assert.equal((await f.repository.listThemes()).length, 0);
    assert.ok(!logs.includes('Retained private draft'));
    assert.ok(!logs.includes('private database diagnostic'));
  });

  test('public submission rates persist across app instances, ignore spoofed headers and expire', async context => {
    const f = await fixture(context);
    const ip = '198.51.100.77';
    for (let i = 0; i < 5; i++) assert.equal((await f.post({ kind: 'single', text: `Allowed ${i}` }, ip, { 'x-forwarded-for': `203.0.113.${i}` })).statusCode, 303);
    const next = f.openApp();
    await next.app.ready();
    const blocked = await next.app.inject({ method: 'POST', url: '/', remoteAddress: ip, headers: { 'x-forwarded-for': '203.0.113.99' }, payload: { kind: 'single', text: 'Rate limited draft' } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.match(blocked.body, /Rate limited draft/);
    assert.equal((await f.repository.list()).length, 5);
    const counters = await f.pool.query('SELECT * FROM submission_rate_limits');
    assert.ok(!JSON.stringify(counters.rows).includes(ip));
    await f.pool.query("UPDATE submission_rate_limits SET window_started_at = clock_timestamp() - INTERVAL '2 minutes'");
    assert.equal((await f.post({ kind: 'single', text: 'After expiry' }, ip)).statusCode, 303);
  });

  test('public limits use the trusted client chain and public routes expose no collected jokes or exports', async context => {
    const f = await fixture(context, false, '192.0.2.1/32');
    for (let i = 0; i < 5; i++) assert.equal((await f.post({ kind: 'single', text: 'Hidden joke' }, '192.0.2.1', { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` })).statusCode, 303);
    assert.equal((await f.post({ kind: 'single', text: 'Blocked' }, '192.0.2.1', { 'x-forwarded-for': '203.0.113.99, 198.51.100.7' })).statusCode, 429);
    assert.equal((await f.post({ kind: 'single', text: 'Other visitor' }, '192.0.2.1', { 'x-forwarded-for': '198.51.100.8' })).statusCode, 303);
    for (const url of ['/jokes', '/themes', '/api/jokes', '/export']) assert.equal((await f.app.inject(url)).statusCode, 404);
    assert.equal((await f.app.inject('/admin/export')).statusCode, 401);
    assert.ok(!(await f.app.inject('/')).body.includes('Hidden joke'));
  });
});
