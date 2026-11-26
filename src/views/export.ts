import type { DeckUsage } from '../domain.ts';
import { renderAdminPage } from './admin.ts';
import { feedback, hidden } from './admin-forms.ts';
import { escapeHtml } from './html.ts';

export function renderExport(csrf: string, decks: DeckUsage[], selected: string[] = [], message = ''): string {
  return renderAdminPage(csrf, `<h2>Export decks</h2>
<p>Download whole decks for the OSRS Jokes plugin. Theme filters and selected joke rows do not limit this export. Unassigned jokes are excluded; empty decks are included.</p>
${feedback(message, true)}
${decks.length ? `<form method="post" action="/admin/export">
${hidden('csrf', csrf)}<fieldset class="export-decks"><legend>Choose decks</legend>
${decks.map(deck => `<label><input type="checkbox" name="deckIds" value="${deck.id}"${selected.includes(deck.id) ? ' checked' : ''}><span>${escapeHtml(deck.name)} <span class="hint">(${deck.jokeCount} ${deck.jokeCount === 1 ? 'joke' : 'jokes'})</span></span></label>`).join('')}
</fieldset><p class="hint">Download all decks includes every deck at download time, regardless of the checkboxes.</p>
<div class="actions"><button type="submit" name="scope" value="selected">Download selected decks</button><button class="secondary" type="submit" name="scope" value="all">Download all decks</button></div></form>` : '<p role="status">No decks yet. <a href="/admin/decks">Create a deck</a> before exporting.</p>'}`, 'export');
}
