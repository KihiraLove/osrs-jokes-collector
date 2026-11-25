import type { JokeKind, Theme } from '../domain.ts';
import { MAX_JOKE_LENGTH, MAX_THEMES } from '../normalization.ts';
import { escapeHtml } from './html.ts';
import { renderThemePicker } from './theme-picker.ts';

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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OSRS Jokes</title><link rel="stylesheet" href="/styles.css">
  <script type="module" src="/submission.js"></script>
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
    ${renderThemePicker(themes, draft)}
    <button id="submit-joke" type="submit">Submit joke</button>
  </form>
</main></body></html>`;
}
