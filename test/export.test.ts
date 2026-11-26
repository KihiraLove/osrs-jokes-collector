import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

const emptyId = '10000000-0000-4000-8000-000000000001';
const fullId = '10000000-0000-4000-8000-000000000002';
const firstId = '20000000-0000-4000-8000-000000000003';
const secondId = '20000000-0000-4000-8000-000000000001';
const thirdId = '20000000-0000-4000-8000-000000000002';

interface ExportDocument { decks: { id: string; name: string; jokes: string[] }[] }

describe('admin deck export', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  let schemaValidator: FastifyInstance;
  let oneExample: string;
  let multiExample: string;
  before(async () => {
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
    oneExample = await readFile(new URL('../docs/examples/one-deck.json', import.meta.url), 'utf8');
    multiExample = await readFile(new URL('../docs/examples/decks.json', import.meta.url), 'utf8');
    // Exercise the published schema with Fastify's existing JSON Schema validator.
    // Disable coercion/removal so invalid documents cannot be silently repaired.
    schemaValidator = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
    schemaValidator.post('/check', { schema: { body: JSON.parse(await readFile(new URL('../docs/decks.schema.json', import.meta.url), 'utf8')) } }, async (_request, reply) => reply.code(204).send());
  });
  after(async () => {
    try { await schemaValidator?.close(); await maintenance?.end(); }
    finally { await database?.close(); }
  });

  const cookieFrom = (headers: Record<string, unknown>) => String(Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] : headers['set-cookie']).split(';')[0]!;
  const csrfFrom = (body: string) => body.match(/name="csrf" value="([a-f0-9]{64})"/)![1]!;

  async function fixture(context: TestContext) {
    const schema = `export_test_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
    const repository = new JokeRepository(pool);
    const store = new AdminStore(pool);
    const origin = 'https://jokes.example.com';
    let key = '';
    const app = createApp(databaseLifecycle(pool), false, { repository, store, settings: adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), onInitialKey: value => { key = value; } });
    context.after(async () => { try { await app.close(); } finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); } });
    const challenge = await app.inject('/admin');
    const login = await app.inject({ method: 'POST', url: '/admin/login', headers: { origin, cookie: cookieFrom(challenge.headers) }, payload: { key, csrf: csrfFrom(challenge.body) } });
    assert.equal(login.statusCode, 303);
    const cookie = cookieFrom(login.headers);
    const get = (url = '/admin/export') => app.inject({ url, headers: { cookie } });
    const csrf = csrfFrom((await get('/admin/jokes')).body);
    const post = (fields: Record<string, unknown> = {}, url = '/admin/export') => app.inject({ method: 'POST', url, headers: { origin, cookie }, payload: { csrf, ...fields } });

    async function seed() {
      for (const [id, name] of [[emptyId, 'Empty deck'], [fullId, 'Gielinor "jokes" \\ 🦀']] as const) {
        const deck = await repository.createDeck(name);
        await pool.query('UPDATE decks SET id = $1 WHERE id = $2', [id, deck.id]);
      }
      await pool.query(`INSERT INTO jokes (id, kind, text, punchline, created_at, deck_id) VALUES
        ($1, 'single', $2, NULL, '2026-01-01T00:00:00.000001Z', $9),
        ($3, 'two_part', $4, $5, '2026-01-01T00:00:00.000002Z', $9),
        ($6, 'single', $7, NULL, '2026-01-01T00:00:00.000002Z', $9),
        ($8, 'single', 'Unassigned private', NULL, '2026-01-01T00:00:00.000003Z', NULL)`, [
        firstId, 'The Wise Old Man said "bank it". Path: C:\\Gielinor\\bank.',
        secondId, 'Why did the crab cross the shore?', 'To say 你好, café! 🦀\nThen scuttle away.',
        thirdId, 'Keep // this and /* that */ as text.\r\nNext line\twith a tab.\n\nA blank line stays.', randomUUID(), fullId,
      ]);
      await repository.setThemes(firstId, ['PvM']);
      await repository.setThemes(secondId, ['Skilling']);
      const otherJoke = await repository.submit({ kind: 'single', text: 'Only in the other deck' });
      const other = await repository.createDeckWithJokes('Zulu deck', [otherJoke.id]);
      return { other, otherJoke };
    }
    return { pool, repository, app, origin, cookie, csrf, key, get, post, seed };
  }

  async function assertSchema(document: unknown) {
    const response = await schemaValidator.inject({ method: 'POST', url: '/check', payload: document as Record<string, unknown> });
    assert.equal(response.statusCode, 204, response.body);
  }

  test('one, multiple and all decks produce private UTF-8 schema-compliant downloads and golden fixtures', async context => {
    const f = await fixture(context);
    const { other } = await f.seed();
    const one = await f.post({ scope: 'selected', deckIds: fullId });
    const multi = await f.post({ scope: 'selected', deckIds: [fullId.toUpperCase(), emptyId, fullId] });
    const all = await f.post({ scope: 'all' });
    assert.equal(one.body, oneExample);
    assert.equal(multi.body, multiExample);
    for (const response of [one, multi, all]) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['content-disposition'], 'attachment; filename="decks.json"');
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers.pragma, 'no-cache');
      assert.equal(response.headers.vary, 'Cookie');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['set-cookie'], undefined);
      await assertSchema(response.json());
      assert.ok(!response.body.includes(f.key) && !response.body.includes(f.csrf) && !response.body.includes(f.cookie));
      assert.ok(!response.body.includes('Unassigned private') && !response.body.includes(firstId));
      assert.deepEqual(Object.keys(response.json()), ['decks']);
      for (const deck of response.json<ExportDocument>().decks) assert.deepEqual(Object.keys(deck), ['id', 'name', 'jokes']);
    }
    assert.deepEqual(all.json<ExportDocument>().decks.map(deck => deck.id), [emptyId, fullId, other.id]);
    const duplicate = await f.post({ scope: 'selected', deckIds: [other.id.toUpperCase(), other.id] });
    assert.deepEqual(duplicate.json<ExportDocument>().decks.map(deck => deck.id), [other.id]);
    const empty = await f.post({ scope: 'selected', deckIds: emptyId });
    assert.deepEqual(empty.json(), { decks: [{ id: emptyId, name: 'Empty deck', jokes: [] }] });
    await assertSchema(empty.json());
    assert.equal((await f.post({ scope: 'selected', deckIds: [emptyId, fullId] })).body, multi.body);
    assert.equal((await f.post({ scope: 'all' })).body, all.body);
  });

  test('exports ignore filters and row selections while retaining the saved joke selection', async context => {
    const f = await fixture(context);
    await f.seed();
    const theme = (await f.repository.getJoke(firstId))!.themes[0]!;
    assert.equal((await f.post({ action: 'page', pageIds: [firstId], selectedIds: [firstId] }, '/admin/selection')).statusCode, 303);
    const response = await f.post({ scope: 'selected', deckIds: fullId, theme: theme.id, before: 'invalid', expectedIds: [firstId], deck: 'unassigned' }, `/admin/export?theme=${theme.id}`);
    assert.equal(response.body, oneExample);
    assert.deepEqual((await f.get('/admin/selection')).json().ids, [firstId]);
  });

  test('selection errors never download partial data and the refreshed form retains surviving selected decks', async context => {
    const f = await fixture(context);
    assert.match((await f.get()).body, /No decks yet/);
    const noDecks = await f.post({ scope: 'all' });
    assert.equal(noDecks.statusCode, 422);
    assert.match(noDecks.body, /There are no decks to export/);
    await f.seed();
    for (const fields of [{}, { scope: 'invalid' }, { scope: ['selected', 'all'] }, { scope: 'selected' }, { scope: 'selected', deckIds: [] }, { scope: 'selected', deckIds: 'invalid' }, { scope: 'selected', deckIds: { id: fullId } }, { scope: 'selected', deckIds: [fullId, 5] }]) {
      const response = await f.post(fields);
      assert.equal(response.statusCode, 422);
      assert.equal(response.headers['content-disposition'], undefined);
      assert.match(response.body, /role="alert"/);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const stale = await f.post({ scope: 'selected', deckIds: [fullId, randomUUID()] });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.headers['content-disposition'], undefined);
    assert.match(stale.body, /Some selected decks no longer exist/);
    assert.ok(stale.body.includes(`value="${fullId}" checked`));
    assert.equal((await f.post({ scope: 'selected', deckIds: fullId })).body, oneExample);
    // All means the decks that exist now, regardless of stale checkbox values.
    assert.equal((await f.post({ scope: 'all', deckIds: randomUUID() })).statusCode, 200);
  });

  test('rename, move and deletion are reflected without changing stable IDs or losing preserved text', async context => {
    const f = await fixture(context);
    const { other } = await f.seed();
    await f.repository.renameDeck(fullId, 'A renamed deck');
    await f.repository.assignDeck([secondId], other.id);
    await f.repository.deleteJoke(thirdId);
    const renamed = (await f.post({ scope: 'selected', deckIds: fullId })).json<ExportDocument>();
    assert.equal(renamed.decks[0]!.id, fullId);
    assert.equal(renamed.decks[0]!.name, 'A renamed deck');
    assert.deepEqual(renamed.decks[0]!.jokes, [JSON.parse(oneExample).decks[0].jokes[0]]);
    const moved = (await f.post({ scope: 'selected', deckIds: other.id })).json<ExportDocument>();
    assert.equal(moved.decks[0]!.jokes[0], JSON.parse(oneExample).decks[0].jokes[1]);
    await f.repository.deleteDeck(other.id);
    const all = await f.post({ scope: 'all' });
    assert.ok(!all.body.includes('Only in the other deck') && !all.body.includes('Why did the crab'));
    assert.equal((await f.repository.getJoke(secondId))!.text, 'Why did the crab cross the shore?');
    const deleted = await f.post({ scope: 'selected', deckIds: [emptyId, other.id] });
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.headers['content-disposition'], undefined);
  });

  test('an in-flight atomic rename and move is seen entirely before or after commit', async context => {
    const f = await fixture(context);
    await f.seed();
    const writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("UPDATE decks SET name = 'Renamed', normalized_name = 'renamed' WHERE id = $1", [fullId]);
      await writer.query('UPDATE jokes SET deck_id = $1 WHERE id = $2', [emptyId, firstId]);
      const before = await f.post({ scope: 'selected', deckIds: [fullId, emptyId] });
      assert.equal(before.body, multiExample);
      await writer.query('COMMIT');
      const after = (await f.post({ scope: 'selected', deckIds: [fullId, emptyId] })).json<ExportDocument>();
      assert.equal(after.decks[0]!.jokes.length, 1);
      assert.equal(after.decks[1]!.name, 'Renamed');
      assert.equal(after.decks[1]!.jokes.length, 2);
      assert.equal(after.decks.flatMap(deck => deck.jokes).length, 3);
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });

  test('export form is native, escapes names and accepts URL-encoded multi-deck submissions', async context => {
    const f = await fixture(context);
    await f.seed();
    const dangerous = await f.repository.createDeck('<img src=x onerror=alert(1)>');
    const page = await f.get();
    assert.match(page.body, /href="\/admin\/export" aria-current="page"/);
    assert.match(page.body, /<form method="post" action="\/admin\/export">/);
    assert.match(page.body, /<legend>Choose decks<\/legend>/);
    assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.ok(!page.body.includes('<img src=x'));
    assert.match(page.body, /Empty deck.*\(0 jokes\)/s);
    const payload = new URLSearchParams({ csrf: f.csrf, scope: 'selected' });
    payload.append('deckIds', fullId);
    payload.append('deckIds', emptyId);
    const response = await f.app.inject({ method: 'POST', url: '/admin/export', headers: { origin: f.origin, cookie: f.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: payload.toString() });
    assert.equal(response.body, multiExample);
    assert.ok(!response.body.includes(dangerous.id));
  });

  test('authentication, CSRF and same-origin verification also protect downloads and database failures stay private', async context => {
    const f = await fixture(context);
    await f.seed();
    for (const method of ['GET', 'POST'] as const) {
      const response = await f.app.inject({ method, url: '/admin/export', ...(method === 'POST' ? { payload: { scope: 'all' } } : {}) });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['content-disposition'], undefined);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    for (const [origin, csrf] of [[f.origin, undefined], ['https://evil.example', f.csrf]] as const) {
      const response = await f.app.inject({ method: 'POST', url: '/admin/export', headers: { cookie: f.cookie, origin }, payload: { scope: 'all', csrf } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers['content-disposition'], undefined);
    }
    f.repository.readDecks = async () => { throw new Error('private PostgreSQL password and query details'); };
    const failure = await f.post({ scope: 'all' });
    assert.equal(failure.statusCode, 500);
    assert.equal(failure.headers['content-disposition'], undefined);
    assert.match(failure.body, /temporarily unavailable/);
    assert.ok(!failure.body.includes('password') && !failure.body.includes('PostgreSQL'));
    await f.post({}, '/admin/logout');
    assert.equal((await f.post({ scope: 'all' })).statusCode, 401);
  });

  test('published JSON Schema rejects incomplete documents, empty exports, unknown metadata and non-string jokes', async () => {
    for (const document of [{}, { decks: [] }, { decks: [{ id: 'a', name: 'A', jokes: [] }], csrf: 'secret' }, { decks: [{ id: 'a', name: 'A', jokes: [], theme: 'PvM' }] }, { decks: [{ id: ' ', name: 'A', jokes: [] }] }, { decks: [{ id: 'a', name: '\t', jokes: [] }] }, { decks: [{ id: 'a', name: 'A' }] }, { decks: [{ id: 'a', name: 'A', jokes: [1] }] }]) {
      assert.equal((await schemaValidator.inject({ method: 'POST', url: '/check', payload: document })).statusCode, 400);
    }
    await assertSchema(JSON.parse(oneExample));
    await assertSchema(JSON.parse(multiExample));
  });
});
