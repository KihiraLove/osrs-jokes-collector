import { ValidationError } from './domain.ts';
import { normalizeName, normalizeThemes } from './normalization.ts';

export interface ThemeDraft { themes: string[]; newThemes: string }

export function readThemeDraft(body: Record<string, unknown>): ThemeDraft {
  return {
    themes: typeof body.themes === 'string' ? [body.themes] : Array.isArray(body.themes) ? body.themes.filter((value): value is string => typeof value === 'string') : [],
    newThemes: typeof body.newThemes === 'string' ? body.newThemes : '',
  };
}

export function parseThemeInput(body: Record<string, unknown>): string[] {
  if ((body.themes !== undefined && typeof body.themes !== 'string' && (!Array.isArray(body.themes) || !body.themes.every(value => typeof value === 'string')))
    || (body.newThemes !== undefined && typeof body.newThemes !== 'string')) {
    throw new ValidationError('Choose theme names or enter new themes one per line.');
  }
  const draft = readThemeDraft(body);
  const names = [...draft.themes, ...draft.newThemes.split(/\r?\n/u).filter(name => /[^\p{White_Space}\uFEFF]/u.test(name))];
  const unique = new Map(names.map(name => { const value = normalizeName(name, 80); return [value.key, value.name]; }));
  return normalizeThemes([...unique.values()]).map(theme => theme.name);
}
