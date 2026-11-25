import type { Theme } from '../domain.ts';
import { MAX_THEMES, normalizeName } from '../normalization.ts';
import type { ThemeDraft } from '../theme-input.ts';
import { escapeHtml } from './html.ts';

export function renderThemePicker(themes: Theme[], draft: ThemeDraft): string {
  const selected = new Set(draft.themes.map(name => {
    try { return normalizeName(name, 80).key; } catch { return name; }
  }));
  const catalog = new Set(themes.map(theme => normalizeName(theme.name, 80).key));
  const newThemes = [draft.newThemes, ...draft.themes.filter(name => {
    try { return !catalog.has(normalizeName(name, 80).key); } catch { return true; }
  })].filter(Boolean).join('\n');
  return `<fieldset class="themes">
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
    </fieldset>`;
}
