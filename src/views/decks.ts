import type { DeckUsage, JokeSelection } from '../domain.ts';
import { listingUrl } from '../admin/listing.ts';
import type { ListingState } from '../admin/listing.ts';
import { renderAdminPage } from './admin.ts';
import { contextFields, feedback, hidden } from './admin-forms.ts';
import { escapeHtml } from './html.ts';

export interface AssignmentDraft { target: string; name: string }
export interface SelectionControls {
  selection: JokeSelection;
  decks: DeckUsage[];
  draft?: AssignmentDraft;
  message?: string;
  error?: boolean;
}

export function renderSelection(csrf: string, visible: string[], state: ListingState, controls: SelectionControls): string {
  const { selection, decks } = controls;
  const draft = controls.draft ?? { target: '', name: '' };
  const hiddenCount = selection.ids.filter(id => !visible.includes(id)).length;
  return `<section id="selection-panel" data-selected-ids="${escapeHtml(JSON.stringify(selection.ids))}" data-stale-ids="${escapeHtml(JSON.stringify(selection.staleIds))}">
<h2>Selected jokes</h2><p id="selection-summary" role="status" tabindex="-1">${selection.ids.length} selected. ${hiddenCount} hidden on other pages or by current filters.</p>
<p id="stale-selection" class="error"${selection.staleIds.length ? '' : ' hidden'}>${selection.staleIds.length} selected jokes were deleted. Remove deleted selections or clear the selection before assigning.</p>
<p id="selection-error" class="error" role="alert"></p>
<form class="selection-controls" id="selection-form" method="post" action="/admin/selection">${hidden('csrf', csrf)}${contextFields(state)}${visible.map(id => hidden('pageIds', id)).join('')}
<button class="secondary" id="select-page" type="submit" name="action" value="all"${visible.length ? '' : ' disabled'}>Select current page</button>
<button class="secondary" id="clear-selection" type="submit" name="action" value="clear"${selection.ids.length ? '' : ' disabled'}>Clear selection</button>
<button class="secondary" id="prune-selection" type="submit" name="action" value="prune"${selection.staleIds.length ? '' : ' hidden'}>Remove deleted selections</button>
<button id="save-selection" type="submit" name="action" value="page"${visible.length ? '' : ' disabled'}>Update selection</button>
</form><noscript><p class="hint">Use Update selection to save checkbox changes before changing filters or pages.</p></noscript>
<p class="hint">Select current page adds only the visible jokes. Up to 500 jokes can be selected.</p>
<form id="assignment-form" method="post" action="/admin/assign">${hidden('csrf', csrf)}${contextFields(state)}<div id="expected-selection">${selection.ids.map(id => hidden('expectedIds', id)).join('')}</div>
<label for="assignment-target">Deck action</label><div class="select-wrap"><select id="assignment-target" name="target" required>
<option value="" disabled${draft.target ? '' : ' selected'}>Choose an action</option>
<option value="new"${draft.target === 'new' ? ' selected' : ''}>Create a new deck</option>
<option value="none"${draft.target === 'none' ? ' selected' : ''}>Remove from deck</option>
${decks.map(deck => `<option value="${deck.id}"${draft.target === deck.id ? ' selected' : ''}>${escapeHtml(deck.name)} (${deck.jokeCount})</option>`).join('')}</select></div>
<div class="field" id="new-deck-field"><label for="new-deck-name">New deck name (when creating a deck)</label><input id="new-deck-name" name="name" value="${escapeHtml(draft.name)}" maxlength="200"></div>
<button id="apply-deck" type="submit"${selection.ids.length ? '' : ' disabled'}>Apply to selection</button></form></section>`;
}

export function renderDecks(csrf: string, decks: DeckUsage[], name = '', message = '', error = false): string {
  return renderAdminPage(csrf, `<h2>Decks</h2>${feedback(message, error)}
<form method="post" action="/admin/decks">${hidden('csrf', csrf)}<label for="deck-name">New deck name</label><input id="deck-name" name="name" value="${escapeHtml(name)}" maxlength="200" required><button type="submit">Create deck</button></form>
${decks.length ? `<ul class="deck-list">${decks.map(deck => `<li><h3>${escapeHtml(deck.name)}</h3><p>${deck.jokeCount} ${deck.jokeCount === 1 ? 'joke' : 'jokes'}</p><p class="hint">Export ID: <code>${deck.id}</code></p><div class="actions"><a href="${listingUrl({ theme: 'all', deck: deck.id, before: '' })}">View jokes</a><a href="/admin/decks/${deck.id}/rename">Rename deck<span class="visually-hidden"> ${escapeHtml(deck.name)}</span></a><a href="/admin/decks/${deck.id}/delete">Delete deck<span class="visually-hidden"> ${escapeHtml(deck.name)}</span></a></div></li>`).join('')}</ul>` : '<p role="status">No decks yet. Create an empty deck here or create one with selected jokes on the Jokes page.</p>'}`, 'decks');
}

export function renderDeckRename(csrf: string, deck: DeckUsage, name = deck.name, message = ''): string {
  return renderAdminPage(csrf, `<h2>Rename deck</h2><p>Export ID: <code>${deck.id}</code></p>${feedback(message, true)}
<form method="post" action="/admin/decks/${deck.id}/rename">${hidden('csrf', csrf)}<label for="deck-name">Deck name</label><input id="deck-name" name="name" value="${escapeHtml(name)}" maxlength="200" required><button type="submit">Save deck name</button><a href="/admin/decks">Cancel</a></form>`, 'decks');
}

export function renderDeckDeletion(csrf: string, deck: DeckUsage, message = ''): string {
  return renderAdminPage(csrf, `<h2>Delete deck “${escapeHtml(deck.name)}”?</h2><p>${deck.jokeCount} ${deck.jokeCount === 1 ? 'joke' : 'jokes'} will become unassigned. Joke text and themes will remain.</p>${feedback(message, true)}
<form method="post" action="/admin/decks/${deck.id}/delete">${hidden('csrf', csrf)}${hidden('confirmation', 'delete')}${hidden('expectedUsage', String(deck.jokeCount))}<button type="submit">Delete this deck</button><a href="/admin/decks">Cancel</a></form>`, 'decks');
}
