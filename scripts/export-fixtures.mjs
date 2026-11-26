import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.ts';
import { adminSettings } from '../src/admin/config.ts';
import { AdminStore } from '../src/admin/store.ts';
import { createPool, databaseLifecycle } from '../src/db/database.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { startTestDatabase } from '../test/helpers/database.ts';
import { emptyId, fullId, seedExportExamples } from '../test/helpers/export-fixtures.ts';

const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--check', '--write'].includes(mode), 'Use --check or --write.');
const database = await startTestDatabase();
const maintenance = createPool({ connectionString: database.connectionString });
const schema = `export_fixture_${randomUUID().replaceAll('-', '')}`;
let app;
let created = false;
try {
  await maintenance.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
  const repository = new JokeRepository(pool);
  const origin = 'https://jokes.example.com';
  let key;
  app = createApp(databaseLifecycle(pool), false, { repository, store: new AdminStore(pool), settings: adminSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin }), onInitialKey: value => { key = value; } });
  const cookieFrom = headers => String(Array.isArray(headers['set-cookie']) ? headers['set-cookie'][0] : headers['set-cookie']).split(';')[0];
  const csrfFrom = body => body.match(/name="csrf" value="([a-f0-9]{64})"/)[1];
  const challenge = await app.inject('/admin');
  const login = await app.inject({ method: 'POST', url: '/admin/login', headers: { origin, cookie: cookieFrom(challenge.headers) }, payload: { key, csrf: csrfFrom(challenge.body) } });
  assert.equal(login.statusCode, 303, 'Fixture login failed.');
  const cookie = cookieFrom(login.headers);
  const csrf = csrfFrom((await app.inject({ url: '/admin/export', headers: { cookie } })).body);
  const post = (url, fields) => app.inject({ method: 'POST', url, headers: { origin, cookie }, payload: { csrf, ...fields } });
  await seedExportExamples(pool, repository);
  const downloads = new Map();
  downloads.set('one-deck.json', await post('/admin/export', { scope: 'selected', deckIds: fullId }));
  downloads.set('decks.json', await post('/admin/export', { scope: 'selected', deckIds: [emptyId, fullId] }));
  assert.equal((await post(`/admin/decks/${fullId}/rename`, { name: 'A renamed deck' })).statusCode, 303, 'Fixture rename failed.');
  downloads.set('renamed-decks.json', await post('/admin/export', { scope: 'selected', deckIds: [emptyId, fullId] }));
  for (const [name, response] of downloads) {
    assert.equal(response.statusCode, 200, `${name}: export failed.`);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['content-disposition'], 'attachment; filename="decks.json"');
    const file = new URL(`../docs/examples/${name}`, import.meta.url);
    // Copy raw attachment bytes. Do not parse/re-serialize or convert the JSON.
    if (mode === '--write') await writeFile(file, response.rawPayload);
    else assert.deepEqual(response.rawPayload, await readFile(file), `${name} differs; regenerate and review both repositories' fixtures.`);
    console.log(`${mode === '--write' ? 'Wrote' : 'Verified'} ${name} SHA-256 ${createHash('sha256').update(response.rawPayload).digest('hex')}`);
  }
} finally {
  try { await app?.close(); }
  finally {
    try { if (created) await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { try { await maintenance.end(); } finally { await database.close(); } }
  }
}
