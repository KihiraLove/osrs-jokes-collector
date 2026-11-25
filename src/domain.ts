export type JokeKind = 'single' | 'two_part';

export interface Theme {
  id: string;
  name: string;
}

export interface Deck {
  id: string;
  name: string;
}

export interface Joke {
  id: string;
  kind: JokeKind;
  text: string;
  punchline: string | null;
  deckId: string | null;
  // Keep PostgreSQL's microsecond precision for keyset pagination.
  createdAt: string;
  themes: Theme[];
}

export interface JokeInput {
  kind: JokeKind;
  text: string;
  punchline?: string | null;
  themes?: string[];
}

export interface JokeCursor {
  createdAt: string;
  id: string;
}

export interface JokeFilter {
  themeId?: string;
  unthemed?: boolean;
  unassigned?: boolean;
  before?: JokeCursor;
  limit?: number;
}

export interface DeckContents extends Deck {
  jokes: Pick<Joke, 'id' | 'kind' | 'text' | 'punchline'>[];
}

export class ValidationError extends Error {}

export class ConflictError extends Error {}
