import type { JokeKind, Theme } from '../domain.ts';
import { MAX_JOKE_LENGTH, MAX_THEMES, normalizeName } from '../normalization.ts';
import { escapeHtml } from './html.ts';

export interface SubmissionDraft {
  kind: JokeKind;
  text: string;
  punchline: string;
  themes: string[];
  newThemes: string;
}

export function emptyDraft(): SubmissionDraft {
  return { kind: 'single', text: '', punchline: '', themes: [], newThemes: '' };
}

export function renderHome(themes: Theme[] = [], draft = emptyDraft(), message = '', submitted = false): string {
  const twoPart = draft.kind === 'two_part';
  const selected = new Set(draft.themes.map(name => {
    try { return normalizeName(name, 80).key; } catch { return name; }
  }));
  const catalog = new Set(themes.map(theme => normalizeName(theme.name, 80).key));
  const newThemes = [draft.newThemes, ...draft.themes.filter(name => {
    try { return !catalog.has(normalizeName(name, 80).key); } catch { return true; }
  })].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OSRS Jokes</title><link rel="stylesheet" href="/styles.css">
  <script src="/submission.js" defer></script>
</head>
<body><main>
  <h1>OSRS Jokes</h1>
  <p>Share a joke for the RuneLite OSRS Jokes plugin.</p>
  ${submitted ? '<p class="success" role="status">Thanks — your joke was submitted. You can send another below.</p>' : ''}
  ${message ? `<p class="error" id="form-error" role="alert" tabindex="-1">${escapeHtml(message)}</p>` : ''}
  <form id="joke-form" method="post" action="/" data-max-themes="${MAX_THEMES}" data-max-part-length="${MAX_JOKE_LENGTH}">
    <fieldset class="joke-type">
      <legend class="visually-hidden">Joke type</legend>
      <label><input type="radio" name="kind" value="single"${twoPart ? '' : ' checked'}><span>Single joke</span></label>
      <label><input type="radio" name="kind" value="two_part"${twoPart ? ' checked' : ''}><span>Two part joke</span></label>
    </fieldset>
    <noscript><button type="submit" name="intent" value="preview" formnovalidate>Update joke type</button></noscript>
    <label id="joke-text-label" for="joke-text">${twoPart ? 'Setup' : 'Joke'}</label>
    <textarea id="joke-text" name="text" rows="4" maxlength="${MAX_JOKE_LENGTH * 2}" aria-describedby="joke-hint" required>${escapeHtml(draft.text)}</textarea>
    <div id="punchline-field" class="field"${twoPart ? '' : ' hidden'}>
      <label for="punchline">Punchline</label>
      <textarea id="punchline" name="punchline" rows="3" maxlength="${MAX_JOKE_LENGTH * 2}" aria-describedby="joke-hint"${twoPart ? ' required' : ' disabled'}>${escapeHtml(draft.punchline)}</textarea>
    </div>
    <p class="hint" id="joke-hint">Up to 4,000 characters per part. Line breaks are welcome.</p>
    <fieldset class="themes">
      <legend>Themes <span class="hint">(optional)</span></legend>
      <p class="hint" id="theme-hint">Choose or add up to ${MAX_THEMES} themes, or leave this empty.</p>
      <div id="theme-entry" class="field" hidden>
        <label for="theme-input">Find or add a theme</label>
        <div class="theme-entry">
          <input id="theme-input" type="text" list="theme-options" autocomplete="off" maxlength="160" aria-describedby="theme-hint theme-feedback">
          <button id="add-theme" type="button">Add theme</button>
        </div>
        <datalist id="theme-options">${themes.map(theme => `<option value="${escapeHtml(theme.name)}"></option>`).join('')}</datalist>
      </div>
      <div id="selected-themes" hidden><p class="hint" id="selected-count" role="status"></p><ul class="selected-themes" aria-label="Selected themes"></ul></div>
      <p class="error" id="theme-feedback" role="status" aria-live="polite"></p>
      <details class="theme-catalog">
        <summary>Choose from all existing themes (${themes.length})</summary>
        <div class="theme-options">${themes.length ? themes.map((theme, index) => `<label for="theme-${index}"><input id="theme-${index}" type="checkbox" name="themes" value="${escapeHtml(theme.name)}"${selected.has(normalizeName(theme.name, 80).key) ? ' checked' : ''}><span>${escapeHtml(theme.name)}</span></label>`).join('') : '<p class="hint">No themes yet. Add the first one.</p>'}</div>
      </details>
      <div id="new-themes-field" class="field">
        <label for="new-themes">New themes (one per line)</label>
        <textarea id="new-themes" name="newThemes" rows="2" aria-describedby="theme-hint">${escapeHtml(newThemes)}</textarea>
      </div>
    </fieldset>
    <button id="submit-joke" type="submit">Submit joke</button>
  </form>
</main></body></html>`;
}
