import type { ListingState } from '../admin/listing.ts';
import { escapeHtml } from './html.ts';

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}
export function contextFields(state: ListingState): string {
  return hidden('theme', state.theme) + hidden('deck', state.deck) + hidden('before', state.before);
}
export function feedback(message: string, error = false): string {
  return message ? `<p class="${error ? 'error' : 'success'}"${error ? ' id="form-error" tabindex="-1" role="alert"' : ' role="status"'}>${escapeHtml(message)}</p>` : '';
}
