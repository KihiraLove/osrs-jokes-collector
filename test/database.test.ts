import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ConflictError } from '../src/domain.ts';
import { createPool } from '../src/db/database.ts';
import { migrate } from '../src/db/migrations.ts';
import { JokeRepository } from '../src/db/repository.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';

const schema = `collector_test_${randomUUID().replaceAll('-', '')}`;
let database: TestDatabase | undefined;
let admin: Pool | undefined;
let pool: Pool;
let repository: JokeRepository;
let schemaCreated = false;

before(async () => {
  database = await startTestDatabase();
  const { connectionString } = database;
  admin = createPool({ connectionString });
  pool = createPool({ connectionString, options: `-c search_path=${schema}` });
  repository = new JokeRepository(pool);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
});

after(async () => {
  try {
    await pool?.end();
    if (schemaCreated) await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    try {
      await admin?.end();
    } finally {
      await database?.close();
    }
  }
});

test('migration startup is concurrent-safe, idempotent and detects changed history', async () => {
  await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
  await migrate(pool);
  assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, 1);
  await pool.query("UPDATE schema_migrations SET checksum = 'changed' RETURNING version");
  try {
    await assert.rejects(migrate(pool), /migration history differs/);
  } finally {
    // This is an isolated schema; removing the ledger row alone would rerun DDL.
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const sql = await readFile(new URL('../src/db/migrations/001_initial.sql', import.meta.url), 'utf8');
    await pool.query('UPDATE schema_migrations SET checksum = $1', [createHash('sha256').update(sql).digest('hex')]);
  }
});

test('database constraints reject malformed joke parts and duplicate relationships/names', async () => {
  await migrate(pool);
  for (const values of [
    ['two_part', 'setup', null], ['two_part', 'setup', '\u00a0\uFEFF'],
    ['single', 'joke', 'punchline'], ['single', '\t\n\u0085', null], ['other', 'joke', null],
  ]) {
    await assert.rejects(pool.query('INSERT INTO jokes (kind, text, punchline) VALUES ($1, $2, $3)', values), { code: '23514' });
  }
  const joke = await repository.submit({ kind: 'single', text: 'Constraint joke', themes: ['Constraints'] });
  await assert.rejects(pool.query('INSERT INTO joke_themes (joke_id, theme_id) VALUES ($1, $2)', [joke.id, joke.themes[0]!.id]), { code: '23505' });
  await assert.rejects(pool.query('INSERT INTO themes (name, normalized_name) VALUES ($1, $2)', ['Constraints', 'constraints']), { code: '23505' });
  await repository.createDeck('Constraint deck');
  await assert.rejects(repository.createDeck(' CONSTRAINT\tdeck '), { code: '23505' });
});

test('concurrent theme submissions converge on one theme with no partial joke writes', async () => {
  await migrate(pool);
  const jokes = await Promise.all(Array.from({ length: 6 }, (_, index) => repository.submit({
    kind: 'two_part', text: `Concurrent ${index}`, punchline: 'Answer',
    themes: index % 2 ? ['Concurrent', ' Other concurrent '] : ['other CONCURRENT', ' concurrent '],
  })));
  assert.equal(new Set(jokes.map(joke => joke.themes.find(theme => theme.name.toLowerCase() === 'concurrent')!.id)).size, 1);
  const themes = await pool.query("SELECT id FROM themes WHERE normalized_name IN ('concurrent', 'other concurrent')");
  assert.equal(themes.rowCount, 2);
  const filtered = await repository.list({ themeId: jokes[0]!.themes[0]!.id });
  assert.equal(filtered.length, 6);
  assert.ok(filtered.every(joke => joke.themes.length === 2 && joke.deckId === null));
});

test('bulk deck assignment is atomic, deduplicated and rejects stale selections', async () => {
  await migrate(pool);
  const first = await repository.submit({ kind: 'single', text: 'Bulk A', themes: ['Bulk A'] });
  const second = await repository.submit({ kind: 'single', text: 'Bulk B', themes: ['Bulk B'] });
  const deck = await repository.createDeck('Bulk deck');
  assert.equal(await repository.assignDeck([first.id, second.id, first.id], deck.id), 2);
  await assert.rejects(repository.assignDeck([first.id, randomUUID()], null), ConflictError);
  await assert.rejects(repository.assignDeck([first.id], randomUUID()), ConflictError);
  await assert.rejects(repository.createDeckWithJokes('Rolled back deck', [first.id, randomUUID()]), ConflictError);
  assert.equal((await pool.query("SELECT id FROM decks WHERE normalized_name = 'rolled back deck'")).rowCount, 0);
  assert.equal((await repository.readDecks([deck.id]))[0]!.jokes.length, 2);
  const renamed = await repository.renameDeck(deck.id, 'Renamed bulk deck');
  assert.equal(renamed.id, deck.id);
  const moved = await repository.createDeckWithJokes('Moved deck', [first.id]);
  assert.equal((await repository.readDecks([moved.id]))[0]!.jokes.length, 1);
  assert.equal((await repository.readDecks([deck.id]))[0]!.jokes.length, 1);
});

test('deleting themes and decks preserves jokes; deleting jokes removes only their links', async () => {
  await migrate(pool);
  const joke = await repository.submit({ kind: 'single', text: 'Preserve me', themes: ['Delete theme', 'Keep theme'] });
  const deck = await repository.createDeckWithJokes('Delete deck', [joke.id]);
  assert.equal(await repository.deleteTheme(joke.themes[0]!.id), true);
  let saved = (await repository.list({ themeId: joke.themes[1]!.id }))[0]!;
  assert.equal(saved.text, 'Preserve me');
  assert.equal(saved.deckId, deck.id);
  assert.equal(saved.themes.length, 1);
  await repository.setThemes(joke.id, []);
  assert.ok((await repository.list({ unthemed: true })).some(row => row.id === joke.id));
  await repository.deleteDeck(deck.id);
  saved = (await repository.list({ unthemed: true, unassigned: true })).find(row => row.id === joke.id)!;
  assert.equal(saved.text, 'Preserve me');
  assert.equal(saved.deckId, null);
  await repository.setThemes(joke.id, ['Keep theme']);
  await repository.deleteJoke(joke.id);
  assert.equal((await pool.query('SELECT * FROM joke_themes WHERE joke_id = $1', [joke.id])).rowCount, 0);
  assert.ok((await repository.listThemes()).some(theme => theme.id === joke.themes[1]!.id));
});

test('pagination preserves microseconds and lists multi-theme jokes once', async () => {
  await migrate(pool);
  const jokes = await Promise.all(['A', 'B', 'C'].map(text => repository.submit({ kind: 'single', text, themes: ['Paging', 'Paging second'] })));
  for (const [index, joke] of jokes.entries()) {
    await pool.query('UPDATE jokes SET created_at = $2::timestamptz WHERE id = $1', [joke.id, `2026-01-01T00:00:00.123${index}00Z`]);
  }
  const themeId = jokes[0]!.themes[0]!.id;
  const seen: string[] = [];
  let before;
  for (let index = 0; index < 3; index++) {
    const [joke] = await repository.list({ themeId, limit: 1, ...(before ? { before } : {}) });
    assert.ok(joke);
    seen.push(joke.id);
    before = { createdAt: joke.createdAt, id: joke.id };
  }
  assert.deepEqual(seen, jokes.map(joke => joke.id).reverse());
  assert.ok(before);
  assert.equal((await repository.list({ themeId, limit: 1, before })).length, 0);
});

test('deck reads include empty decks, exclude unassigned jokes and reject unknown IDs', async () => {
  await migrate(pool);
  const empty = await repository.createDeck('Empty deck');
  const joke = await repository.submit({ kind: 'two_part', text: 'Quote " and \\', punchline: 'Unicode 🦀\nNext line' });
  const full = await repository.createDeckWithJokes('Full deck', [joke.id]);
  await repository.submit({ kind: 'single', text: 'Not exported' });
  const decks = await repository.readDecks([full.id, empty.id, full.id]);
  assert.deepEqual(decks.map(deck => deck.id), [empty.id, full.id]);
  assert.deepEqual(decks[0]!.jokes, []);
  assert.deepEqual(decks[1]!.jokes, [{ id: joke.id, kind: 'two_part', text: joke.text, punchline: joke.punchline }]);
  await assert.rejects(repository.readDecks([full.id, randomUUID()]), ConflictError);
});
