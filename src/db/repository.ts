import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ValidationError } from '../domain.ts';
import type { Deck, DeckContents, Joke, JokeFilter, JokeInput, Theme } from '../domain.ts';
import { normalizeJoke, normalizeName, normalizeThemes } from '../normalization.ts';
import { transaction } from './transaction.ts';

const jokeColumns = `j.id, j.kind, j.text, j.punchline, j.deck_id AS "deckId",
  to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name)
    ORDER BY t.normalized_name, t.id)
    FROM joke_themes jt JOIN themes t ON t.id = jt.theme_id WHERE jt.joke_id = j.id), '[]'::jsonb) AS themes`;

async function resolveThemes(client: PoolClient, names: string[]): Promise<Theme[]> {
  const themes: Theme[] = [];
  for (const { name, key } of normalizeThemes(names)) {
    const result = await client.query<Theme>(`INSERT INTO themes (id, name, normalized_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = EXCLUDED.normalized_name
      RETURNING id, name`, [randomUUID(), name, key]);
    themes.push(result.rows[0]!);
  }
  return themes;
}

async function linkThemes(client: PoolClient, jokeId: string, themes: Theme[]): Promise<void> {
  await client.query(`INSERT INTO joke_themes (joke_id, theme_id)
    SELECT $1::uuid, unnest($2::uuid[])`, [jokeId, themes.map(theme => theme.id)]);
}

async function insertDeck(client: PoolClient, name: string): Promise<Deck> {
  const normalized = normalizeName(name, 100);
  const result = await client.query<Deck>(`INSERT INTO decks (id, name, normalized_name)
    VALUES ($1, $2, $3) RETURNING id, name`, [randomUUID(), normalized.name, normalized.key]);
  return result.rows[0]!;
}

async function assignDeck(client: PoolClient, jokeIds: string[], deckId: string | null): Promise<number> {
  const ids = [...new Set(jokeIds)].sort();
  if (ids.length === 0 || ids.length > 500) throw new ValidationError('Select between 1 and 500 jokes.');
  if (deckId !== null) {
    const deck = await client.query('SELECT id FROM decks WHERE id = $1 FOR KEY SHARE', [deckId]);
    if (!deck.rowCount) throw new ConflictError('The selected deck no longer exists.');
  }
  const jokes = await client.query('SELECT id FROM jokes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  if (jokes.rowCount !== ids.length) throw new ConflictError('Some selected jokes no longer exist. Refresh the selection.');
  await client.query('UPDATE jokes SET deck_id = $1 WHERE id = ANY($2::uuid[])', [deckId, ids]);
  return ids.length;
}

export class JokeRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async submit(input: JokeInput): Promise<Joke> {
    const joke = normalizeJoke(input);
    // Validate the theme count/names before acquiring a connection.
    normalizeThemes(input.themes ?? []);
    return transaction(this.pool, async client => {
      const id = randomUUID();
      await client.query('INSERT INTO jokes (id, kind, text, punchline) VALUES ($1, $2, $3, $4)',
        [id, joke.kind, joke.text, joke.punchline]);
      await linkThemes(client, id, await resolveThemes(client, input.themes ?? []));
      const result = await client.query<Joke>(`SELECT ${jokeColumns} FROM jokes j WHERE j.id = $1`, [id]);
      return result.rows[0]!;
    });
  }

  async listThemes(): Promise<Theme[]> {
    return (await this.pool.query<Theme>('SELECT id, name FROM themes ORDER BY normalized_name, id')).rows;
  }

  async list(filter: JokeFilter = {}): Promise<Joke[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Page size must be between 1 and 100.');
    if (filter.themeId && filter.unthemed) throw new ValidationError('Choose a theme or unthemed, not both.');
    return (await this.pool.query<Joke>(`SELECT ${jokeColumns} FROM jokes j
      WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM joke_themes jt WHERE jt.joke_id = j.id AND jt.theme_id = $1))
        AND (NOT $2::boolean OR NOT EXISTS (SELECT 1 FROM joke_themes jt WHERE jt.joke_id = j.id))
        AND (NOT $3::boolean OR j.deck_id IS NULL)
        AND ($4::timestamptz IS NULL OR (j.created_at, j.id) < ($4::timestamptz, $5::uuid))
      ORDER BY j.created_at DESC, j.id DESC LIMIT $6`, [
      filter.themeId ?? null, filter.unthemed ?? false, filter.unassigned ?? false,
      filter.before?.createdAt ?? null, filter.before?.id ?? null, limit,
    ])).rows;
  }

  async setThemes(jokeId: string, names: string[]): Promise<void> {
    normalizeThemes(names);
    await transaction(this.pool, async client => {
      const joke = await client.query('SELECT id FROM jokes WHERE id = $1 FOR UPDATE', [jokeId]);
      if (!joke.rowCount) throw new ConflictError('The joke no longer exists.');
      const themes = await resolveThemes(client, names);
      await client.query('DELETE FROM joke_themes WHERE joke_id = $1', [jokeId]);
      await linkThemes(client, jokeId, themes);
    });
  }

  async deleteJoke(id: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM jokes WHERE id = $1', [id])).rowCount === 1;
  }

  async deleteTheme(id: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM themes WHERE id = $1', [id])).rowCount === 1;
  }

  async createDeck(name: string): Promise<Deck> {
    return transaction(this.pool, client => insertDeck(client, name));
  }

  async renameDeck(id: string, name: string): Promise<Deck> {
    const normalized = normalizeName(name, 100);
    const result = await this.pool.query<Deck>('UPDATE decks SET name = $2, normalized_name = $3 WHERE id = $1 RETURNING id, name',
      [id, normalized.name, normalized.key]);
    if (!result.rowCount) throw new ConflictError('The deck no longer exists.');
    return result.rows[0]!;
  }

  async deleteDeck(id: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM decks WHERE id = $1', [id])).rowCount === 1;
  }

  async assignDeck(jokeIds: string[], deckId: string | null): Promise<number> {
    return transaction(this.pool, client => assignDeck(client, jokeIds, deckId));
  }

  async createDeckWithJokes(name: string, jokeIds: string[]): Promise<Deck> {
    return transaction(this.pool, async client => {
      const deck = await insertDeck(client, name);
      await assignDeck(client, jokeIds, deck.id);
      return deck;
    });
  }

  async readDecks(deckIds?: string[]): Promise<DeckContents[]> {
    const ids = deckIds ? [...new Set(deckIds)] : null;
    if (ids?.length === 0) throw new ValidationError('Select at least one deck.');
    // One statement gives all selected decks and their jokes one database snapshot.
    const result = await this.pool.query<DeckContents>(`SELECT d.id, d.name,
      COALESCE(jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'text', j.text, 'punchline', j.punchline)
        ORDER BY j.created_at, j.id) FILTER (WHERE j.id IS NOT NULL), '[]'::jsonb) AS jokes
      FROM decks d LEFT JOIN jokes j ON j.deck_id = d.id
      WHERE $1::uuid[] IS NULL OR d.id = ANY($1::uuid[])
      GROUP BY d.id ORDER BY d.normalized_name, d.id`, [ids]);
    if (ids && result.rows.length !== ids.length) throw new ConflictError('Some selected decks no longer exist.');
    return result.rows;
  }
}
