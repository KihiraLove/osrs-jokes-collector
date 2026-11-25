import { ValidationError } from '../domain.ts';
import type { JokeCursor, JokeFilter } from '../domain.ts';

export const PAGE_SIZE = 25;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface ListingState { theme: string; deck: string; before: string }

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(values: Record<string, unknown>, name: string, fallback: string): string {
  const value = values[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ValidationError('Choose one value for each filter.');
  return value;
}

function decodeCursor(value: string): JokeCursor {
  try {
    if (value.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
    const cursor: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(cursor) || cursor.length !== 2) throw new Error();
    const [createdAt, id] = cursor;
    if (typeof id !== 'string' || !UUID.test(id) || typeof createdAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)
      || createdAt.startsWith('0000')
      || new Date(createdAt).toISOString().slice(0, 19) !== createdAt.slice(0, 19)) throw new Error();
    return { createdAt, id };
  } catch { throw new ValidationError('This page link is invalid. Return to the newest jokes and try again.'); }
}

export function readListing(values: unknown): ListingState {
  const input = record(values);
  const theme = field(input, 'theme', 'all');
  const deck = field(input, 'deck', 'all');
  const before = field(input, 'before', '');
  if (theme !== 'all' && theme !== 'none' && !UUID.test(theme)) throw new ValidationError('Choose an existing theme, All themes or No theme.');
  if (deck !== 'all' && deck !== 'unassigned' && !UUID.test(deck)) throw new ValidationError('Choose an existing deck, All decks or Unassigned deck.');
  if (before) decodeCursor(before);
  return { theme: theme.toLowerCase(), deck: deck.toLowerCase(), before };
}

export function listingFilter(state: ListingState): JokeFilter {
  return {
    ...(state.theme === 'none' ? { unthemed: true } : state.theme === 'all' ? {} : { themeId: state.theme }),
    ...(state.deck === 'unassigned' ? { unassigned: true } : state.deck === 'all' ? {} : { deckId: state.deck }),
    ...(state.before ? { before: decodeCursor(state.before) } : {}),
    limit: PAGE_SIZE + 1,
  };
}

export function encodeCursor(cursor: JokeCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

export function listingUrl(state: ListingState, path = '/admin/jokes', notice = ''): string {
  const query = new URLSearchParams();
  if (state.theme !== 'all') query.set('theme', state.theme);
  if (state.deck !== 'all') query.set('deck', state.deck);
  if (state.before) query.set('before', state.before);
  if (notice) query.set('notice', notice);
  return `${path}${query.size ? `?${query}` : ''}`;
}
