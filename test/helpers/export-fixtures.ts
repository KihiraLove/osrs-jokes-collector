import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JokeRepository } from '../../src/db/repository.ts';

export const emptyId = '10000000-0000-4000-8000-000000000001';
export const fullId = '10000000-0000-4000-8000-000000000002';
export const firstId = '20000000-0000-4000-8000-000000000003';
export const secondId = '20000000-0000-4000-8000-000000000001';
export const thirdId = '20000000-0000-4000-8000-000000000002';

// Shared by the HTTP regression tests and the fixture generator. The expected
// JSON files are outputs, never inputs to this seed.
export async function seedExportExamples(pool: Pool, repository: JokeRepository) {
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
