import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ValidationError } from '../domain.ts';
import type { AssignmentCounts, Deck, DeckContents, DeckTarget, DeckUsage, Joke, JokeFilter, JokeInput, JokeSelection, Theme, ThemeUsage } from '../domain.ts';
import { normalizeJoke, normalizeName, normalizeThemes } from '../normalization.ts';
import { transaction } from './transaction.ts';

const jokeColumns = `j.id, j.kind, j.text, j.punchline, j.deck_id AS "deckId",
  (SELECT name FROM decks WHERE id = j.deck_id) AS "deckName",
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

async function assignDeck(client: PoolClient, jokeIds: string[], deckId: string | null): Promise<AssignmentCounts> {
  deckId = deckId?.toLowerCase() ?? null;
  const ids = [...new Set(jokeIds)].sort();
  if (ids.length === 0 || ids.length > 500) throw new ValidationError('Select between 1 and 500 jokes.');
  if (deckId !== null) {
    const deck = await client.query('SELECT id FROM decks WHERE id = $1 FOR KEY SHARE', [deckId]);
    if (!deck.rowCount) throw new ConflictError('The selected deck no longer exists.');
  }
  const jokes = await client.query<{ id: string; deckId: string | null }>('SELECT id, deck_id AS "deckId" FROM jokes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  if (jokes.rowCount !== ids.length) throw new ConflictError('Some selected jokes no longer exist. Refresh the selection.');
  await client.query('UPDATE jokes SET deck_id = $1 WHERE id = ANY($2::uuid[])', [deckId, ids]);
  return { count: ids.length, changed: jokes.rows.filter(joke => joke.deckId !== deckId).length,
    moved: jokes.rows.filter(joke => joke.deckId !== null && joke.deckId !== deckId).length };
}

async function lockSelection(client: PoolClient, sessionHash: Buffer): Promise<void> {
  const session = await client.query(`SELECT token_hash FROM admin_sessions
    WHERE token_hash = $1 AND authenticated AND expires_at > clock_timestamp() FOR UPDATE`, [sessionHash]);
  if (!session.rowCount) throw new ConflictError('Your admin session expired. Log in again.');
}

async function readSelection(client: Pick<Pool, 'query'> | PoolClient, sessionHash: Buffer): Promise<JokeSelection> {
  const result = await client.query<{ id: string; stale: boolean }>(`SELECT s.joke_id AS id, j.id IS NULL AS stale
    FROM admin_joke_selection s LEFT JOIN jokes j ON j.id = s.joke_id WHERE s.session_hash = $1 ORDER BY s.joke_id`, [sessionHash]);
  return { ids: result.rows.map(row => row.id), staleIds: result.rows.filter(row => row.stale).map(row => row.id) };
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

  async listThemeUsage(): Promise<ThemeUsage[]> {
    return (await this.pool.query<ThemeUsage>(`SELECT t.id, t.name, count(jt.joke_id)::int AS "jokeCount"
      FROM themes t LEFT JOIN joke_themes jt ON jt.theme_id = t.id
      GROUP BY t.id ORDER BY t.normalized_name, t.id`)).rows;
  }

  async getTheme(id: string): Promise<ThemeUsage | null> {
    return (await this.pool.query<ThemeUsage>(`SELECT t.id, t.name, count(jt.joke_id)::int AS "jokeCount"
      FROM themes t LEFT JOIN joke_themes jt ON jt.theme_id = t.id
      WHERE t.id = $1 GROUP BY t.id`, [id])).rows[0] ?? null;
  }

  async getJoke(id: string): Promise<Joke | null> {
    return (await this.pool.query<Joke>(`SELECT ${jokeColumns} FROM jokes j WHERE j.id = $1`, [id])).rows[0] ?? null;
  }

  async list(filter: JokeFilter = {}): Promise<Joke[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Page size must be between 1 and 100.');
    if (filter.themeId && filter.unthemed) throw new ValidationError('Choose a theme or unthemed, not both.');
    if (filter.deckId && filter.unassigned) throw new ValidationError('Choose a deck or unassigned, not both.');
    return (await this.pool.query<Joke>(`SELECT ${jokeColumns} FROM jokes j
      WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM joke_themes jt WHERE jt.joke_id = j.id AND jt.theme_id = $1))
        AND (NOT $2::boolean OR NOT EXISTS (SELECT 1 FROM joke_themes jt WHERE jt.joke_id = j.id))
        AND (NOT $3::boolean OR j.deck_id IS NULL)
        AND ($4::timestamptz IS NULL OR (j.created_at, j.id) < ($4::timestamptz, $5::uuid))
        AND ($7::uuid IS NULL OR j.deck_id = $7)
      ORDER BY j.created_at DESC, j.id DESC LIMIT $6`, [
      filter.themeId ?? null, filter.unthemed ?? false, filter.unassigned ?? false,
      filter.before?.createdAt ?? null, filter.before?.id ?? null, limit, filter.deckId ?? null,
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

  async deleteTheme(id: string, expectedUsage?: number): Promise<boolean> {
    return transaction(this.pool, async client => {
      // Block new FK links while checking the count the admin confirmed.
      const theme = await client.query('SELECT id FROM themes WHERE id = $1 FOR UPDATE', [id]);
      if (!theme.rowCount) return false;
      if (expectedUsage !== undefined) {
        const usage = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM joke_themes WHERE theme_id = $1', [id]);
        if (usage.rows[0]!.count !== expectedUsage) throw new ConflictError('Theme usage changed. Review the current count and confirm again.');
      }
      await client.query('DELETE FROM themes WHERE id = $1', [id]);
      return true;
    });
  }

  async createDeck(name: string): Promise<Deck> {
    return transaction(this.pool, client => insertDeck(client, name));
  }

  async listDeckUsage(): Promise<DeckUsage[]> {
    return (await this.pool.query<DeckUsage>(`SELECT d.id, d.name, count(j.id)::int AS "jokeCount"
      FROM decks d LEFT JOIN jokes j ON j.deck_id = d.id GROUP BY d.id ORDER BY d.normalized_name, d.id`)).rows;
  }

  async getDeck(id: string): Promise<DeckUsage | null> {
    return (await this.pool.query<DeckUsage>(`SELECT d.id, d.name, count(j.id)::int AS "jokeCount"
      FROM decks d LEFT JOIN jokes j ON j.deck_id = d.id WHERE d.id = $1 GROUP BY d.id`, [id])).rows[0] ?? null;
  }

  async renameDeck(id: string, name: string): Promise<Deck> {
    const normalized = normalizeName(name, 100);
    const result = await this.pool.query<Deck>('UPDATE decks SET name = $2, normalized_name = $3 WHERE id = $1 RETURNING id, name',
      [id, normalized.name, normalized.key]);
    if (!result.rowCount) throw new ConflictError('The deck no longer exists.');
    return result.rows[0]!;
  }

  async deleteDeck(id: string, expectedUsage?: number): Promise<boolean> {
    return transaction(this.pool, async client => {
      if (!(await client.query('SELECT id FROM decks WHERE id = $1 FOR UPDATE', [id])).rowCount) return false;
      if (expectedUsage !== undefined) {
        const usage = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM jokes WHERE deck_id = $1', [id]);
        if (usage.rows[0]!.count !== expectedUsage) throw new ConflictError('Deck membership changed. Review the current count and confirm again.');
      }
      await client.query('DELETE FROM decks WHERE id = $1', [id]);
      return true;
    });
  }

  async assignDeck(jokeIds: string[], deckId: string | null): Promise<number> {
    return transaction(this.pool, async client => (await assignDeck(client, jokeIds, deckId)).count);
  }

  async selection(sessionHash: Buffer): Promise<JokeSelection> { return readSelection(this.pool, sessionHash); }

  async changeSelection(sessionHash: Buffer, action: 'page' | 'clear' | 'prune', pageIds: string[] = [], selectedIds: string[] = []): Promise<JokeSelection> {
    return transaction(this.pool, async client => {
      await lockSelection(client, sessionHash);
      if (action === 'clear') await client.query('DELETE FROM admin_joke_selection WHERE session_hash = $1', [sessionHash]);
      else if (action === 'prune') await client.query(`DELETE FROM admin_joke_selection s WHERE session_hash = $1
        AND NOT EXISTS (SELECT 1 FROM jokes j WHERE j.id = s.joke_id)`, [sessionHash]);
      else {
        const page = [...new Set(pageIds)];
        const selected = [...new Set(selectedIds)];
        if (!page.length || page.length > 100 || selected.some(id => !page.includes(id))) throw new ValidationError('Select only jokes explicitly shown on this page.');
        if ((await client.query('SELECT id FROM jokes WHERE id = ANY($1::uuid[])', [page])).rowCount !== page.length) throw new ConflictError('Some jokes on this page were deleted. Refresh the page before updating its selection.');
        await client.query('DELETE FROM admin_joke_selection WHERE session_hash = $1 AND joke_id = ANY($2::uuid[]) AND NOT (joke_id = ANY($3::uuid[]))', [sessionHash, page, selected]);
        await client.query(`INSERT INTO admin_joke_selection (session_hash, joke_id) SELECT $1, unnest($2::uuid[])
          ON CONFLICT DO NOTHING`, [sessionHash, selected]);
      }
      const selection = await readSelection(client, sessionHash);
      if (selection.ids.length > 500) throw new ValidationError('Select at most 500 jokes. Clear or reduce the selection first.');
      return selection;
    });
  }

  async assignSelection(sessionHash: Buffer, expectedIds: string[], target: DeckTarget): Promise<AssignmentCounts> {
    return transaction(this.pool, async client => {
      await lockSelection(client, sessionHash);
      const selection = await readSelection(client, sessionHash);
      const expected = [...new Set(expectedIds)].sort();
      if (selection.ids.length !== expected.length || selection.ids.some((id, index) => id !== expected[index])) throw new ConflictError('The selection changed in another tab. Review the current selection and try again.');
      if (!selection.ids.length) throw new ValidationError('Select at least one joke before applying a deck action.');
      if (selection.staleIds.length) throw new ConflictError('Some selected jokes were deleted. Remove deleted selections or clear the selection, then try again.');
      const deckId = target.kind === 'new' ? (await insertDeck(client, target.name)).id : target.kind === 'existing' ? target.id : null;
      const result = await assignDeck(client, selection.ids, deckId);
      await client.query('DELETE FROM admin_joke_selection WHERE session_hash = $1', [sessionHash]);
      return result;
    });
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
