import { ValidationError } from './domain.ts';
import type { JokeInput } from './domain.ts';

export const MAX_JOKE_LENGTH = 4_000;
export const MAX_THEMES = 10;

const edgeWhitespace = /^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu;
const whitespace = /[\p{White_Space}\uFEFF]+/gu;

export function normalizeName(value: string, maxLength: number): { name: string; key: string } {
  const name = value.normalize('NFKC').replace(whitespace, ' ').trim();
  if (!name || [...name].length > maxLength || name.includes('\0')) {
    throw new ValidationError(`Name must contain 1–${maxLength} characters.`);
  }
  return { name, key: name.toLowerCase() };
}

export function normalizeThemes(values: string[]): { name: string; key: string }[] {
  if (values.length > MAX_THEMES) {
    throw new ValidationError(`Choose at most ${MAX_THEMES} themes.`);
  }
  const unique = new Map<string, { name: string; key: string }>();
  for (const value of values) {
    const theme = normalizeName(value, 80);
    if (!unique.has(theme.key)) unique.set(theme.key, theme);
  }
  // Consistent upsert order avoids deadlocks for overlapping theme selections.
  return [...unique.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function normalizeText(value: string): string {
  const text = value.replace(edgeWhitespace, '');
  if (!text || [...text].length > MAX_JOKE_LENGTH || text.includes('\0')) {
    throw new ValidationError(`Joke parts must contain 1–${MAX_JOKE_LENGTH} characters.`);
  }
  return text;
}

export function normalizeJoke(input: JokeInput): { kind: JokeInput['kind']; text: string; punchline: string | null } {
  if (input.kind !== 'single' && input.kind !== 'two_part') {
    throw new ValidationError('Choose a single or two-part joke.');
  }
  if (input.kind === 'single' && input.punchline != null) {
    throw new ValidationError('A single joke cannot have a punchline.');
  }
  if (input.kind === 'two_part' && typeof input.punchline !== 'string') {
    throw new ValidationError('A two-part joke needs a punchline.');
  }
  return {
    kind: input.kind,
    text: normalizeText(input.text),
    punchline: input.kind === 'two_part' ? normalizeText(input.punchline!) : null,
  };
}
