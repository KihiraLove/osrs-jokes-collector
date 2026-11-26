import type { DeckContents } from '../domain.ts';

// Explicitly project the plugin contract; never serialize database records directly.
export function serializeDecks(decks: DeckContents[]): string {
  return JSON.stringify({
    decks: decks.map(deck => ({
      id: deck.id,
      name: deck.name,
      jokes: deck.jokes.map(joke => joke.kind === 'two_part' ? `${joke.text}\n\n${joke.punchline!}` : joke.text),
    })),
  }, null, 2) + '\n';
}
