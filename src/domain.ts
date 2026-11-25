export type JokeKind = 'single' | 'two_part';

export interface Theme {
  id: string;
  name: string;
}

export interface ThemeUsage extends Theme {
  jokeCount: number;
}

export interface Deck {
  id: string;
  name: string;
}

export interface DeckUsage extends Deck { jokeCount: number }
export interface JokeSelection { ids: string[]; staleIds: string[] }
export type DeckTarget = { kind: 'existing'; id: string } | { kind: 'new'; name: string } | { kind: 'none' };
export interface AssignmentCounts { count: number; changed: number; moved: number }

export interface Joke {
  id: string;
  kind: JokeKind;
  text: string;
  punchline: string | null;
  deckId: string | null;
  deckName: string | null;
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
  deckId?: string;
  before?: JokeCursor;
  limit?: number;
}

export interface DeckContents extends Deck {
  jokes: Pick<Joke, 'id' | 'kind' | 'text' | 'punchline'>[];
}

export class ValidationError extends Error {}

export class ConflictError extends Error {}
