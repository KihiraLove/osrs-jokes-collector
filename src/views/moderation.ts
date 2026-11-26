import type { Joke, Theme, ThemeUsage } from '../domain.ts';
import { MAX_THEMES } from '../normalization.ts';
import { encodeCursor, listingUrl } from '../admin/listing.ts';
import type { ListingState } from '../admin/listing.ts';
import type { ThemeDraft } from '../theme-input.ts';
import { renderAdminPage } from './admin.ts';
import { escapeHtml } from './html.ts';
import { renderThemePicker } from './theme-picker.ts';
import { contextFields, feedback, hidden } from './admin-forms.ts';
import { renderSelection } from './decks.ts';
import type { SelectionControls } from './decks.ts';

function jokeDetails(joke: Joke): string {
  const date = joke.createdAt.slice(0, 19).replace('T', ' ') + ' UTC';
  return `<h2>${joke.kind === 'single' ? 'Single joke' : 'Two part joke'}</h2>
<p class="hint">Submitted <time datetime="${escapeHtml(joke.createdAt)}">${date}</time> · Deck: ${escapeHtml(joke.deckName ?? 'Unassigned')}</p>
${joke.kind === 'two_part' ? '<h3>Setup</h3>' : ''}<p class="joke-text">${escapeHtml(joke.text)}</p>
${joke.punchline !== null ? `<h3>Punchline</h3><p class="joke-text">${escapeHtml(joke.punchline)}</p>` : ''}
<p class="joke-themes">Themes: ${joke.themes.length ? joke.themes.map(theme => `<span>${escapeHtml(theme.name)}</span>`).join(', ') : 'No theme'}</p>`;
}

export function renderJokes(csrf: string, jokes: Joke[], themes: ThemeUsage[], state: ListingState, hasMore: boolean, controls: SelectionControls): string {
  const options = [['all', 'All themes'], ['none', 'No theme'], ...themes.map(theme => [theme.id, `${theme.name} (${theme.jokeCount})`])];
  const last = jokes.at(-1);
  return renderAdminPage(csrf, `${feedback(controls.message ?? '', controls.error)}<h2>Collected jokes</h2>
<form class="filters" method="get" action="/admin/jokes">
<div class="field"><label for="filter-theme">Theme</label><div class="select-wrap"><select id="filter-theme" name="theme">${options.map(([value, label]) => `<option value="${escapeHtml(value!)}"${state.theme === value ? ' selected' : ''}>${escapeHtml(label!)}</option>`).join('')}</select></div></div>
<div class="field"><label for="filter-deck">Deck</label><div class="select-wrap"><select id="filter-deck" name="deck"><option value="all"${state.deck === 'all' ? ' selected' : ''}>All decks</option><option value="unassigned"${state.deck === 'unassigned' ? ' selected' : ''}>Unassigned deck</option>${controls.decks.map(deck => `<option value="${deck.id}"${state.deck === deck.id ? ' selected' : ''}>${escapeHtml(deck.name)} (${deck.jokeCount})</option>`).join('')}</select></div></div>
<button type="submit">Apply filters</button></form>
${renderSelection(csrf, jokes.map(joke => joke.id), state, controls)}
${jokes.length ? jokes.map(joke => `<article class="joke-card" id="joke-${joke.id}" data-joke-id="${joke.id}"><label class="joke-select"><input type="checkbox" form="selection-form" name="selectedIds" value="${joke.id}"${controls.selection.ids.includes(joke.id) ? ' checked' : ''}>Select joke</label>${jokeDetails(joke)}<div class="actions"><a href="${escapeHtml(listingUrl(state, `/admin/jokes/${joke.id}/themes`))}">Edit themes</a><a href="${escapeHtml(listingUrl(state, `/admin/jokes/${joke.id}/delete`))}">Delete joke</a></div></article>`).join('') : `<p role="status">${state.theme === 'all' && state.deck === 'all' && !state.before ? 'No jokes have been collected yet.' : 'No jokes match this page and its filters.'}</p>`}
<nav class="pagination" aria-label="Joke pages">${state.before ? `<a href="${escapeHtml(listingUrl({ ...state, before: '' }))}">Newest page</a>` : ''}${hasMore && last ? `<a rel="next" href="${escapeHtml(listingUrl({ ...state, before: encodeCursor(last) }))}">Older jokes</a>` : ''}</nav>`, 'jokes', 'admin-selection');
}

export function renderThemes(csrf: string, themes: ThemeUsage[], message = ''): string {
  return renderAdminPage(csrf, `<h2>Themes</h2>${feedback(message)}<p>Deleting a theme removes its joke associations. Joke text and deck assignments are preserved.</p>
${themes.length ? `<ul class="theme-usage">${themes.map(theme => `<li><div><strong>${escapeHtml(theme.name)}</strong><p class="hint">${theme.jokeCount} ${theme.jokeCount === 1 ? 'joke' : 'jokes'}</p></div><a href="/admin/themes/${theme.id}/delete">Delete theme<span class="visually-hidden"> ${escapeHtml(theme.name)}</span></a></li>`).join('')}</ul>` : '<p role="status">No themes have been created yet.</p>'}`, 'themes');
}

export function renderThemeEditor(csrf: string, joke: Joke, themes: Theme[], state: ListingState, draft: ThemeDraft, message = ''): string {
  return renderAdminPage(csrf, `<h2>Edit joke themes</h2><article class="joke-card">${jokeDetails(joke)}</article>${feedback(message, true)}
<form id="theme-form" method="post" action="/admin/jokes/${joke.id}/themes" data-max-themes="${MAX_THEMES}">${hidden('csrf', csrf)}${contextFields(state)}
${renderThemePicker(themes, draft)}<p class="hint">Remove every selection to leave this joke without a theme.</p>
<button id="save-themes" type="submit">Save themes</button><a href="${escapeHtml(listingUrl(state))}">Cancel</a></form>`, 'jokes', 'theme-editor');
}

export function renderJokeDeletion(csrf: string, joke: Joke, state: ListingState, message = ''): string {
  return renderAdminPage(csrf, `<h2>Delete this joke?</h2><p>The joke and its theme associations will be removed permanently. Its deck and themes will remain.</p>
<article class="joke-card">${jokeDetails(joke)}</article>${feedback(message, true)}
<form method="post" action="/admin/jokes/${joke.id}/delete">${hidden('csrf', csrf)}${hidden('confirmation', 'delete')}${contextFields(state)}
<button type="submit">Delete this joke</button><a href="${escapeHtml(listingUrl(state))}">Cancel</a></form>`);
}

export function renderThemeDeletion(csrf: string, theme: ThemeUsage, message = ''): string {
  return renderAdminPage(csrf, `<h2>Delete theme “${escapeHtml(theme.name)}”?</h2>
<p>This will remove the theme and its <strong>${theme.jokeCount} joke ${theme.jokeCount === 1 ? 'association' : 'associations'}</strong>. All joke text and deck assignments will remain.</p>
${feedback(message, true)}<form method="post" action="/admin/themes/${theme.id}/delete">${hidden('csrf', csrf)}${hidden('confirmation', 'delete')}${hidden('expectedUsage', String(theme.jokeCount))}
<button type="submit">Delete this theme</button><a href="/admin/themes">Cancel</a></form>`, 'themes');
}

export function renderModerationNotice(csrf: string, message: string): string {
  return renderAdminPage(csrf, `${feedback(message, true)}<p><a href="/admin/jokes">Return to newest jokes</a></p>`);
}
