import { enhanceThemePicker } from '/theme-picker.js';

const form = document.querySelector('#theme-form');
if (form) {
  const picker = enhanceThemePicker(form);
  const button = document.querySelector('#save-themes');
  let saving = false;
  form.addEventListener('submit', event => {
    if (saving || !picker.addPending()) { event.preventDefault(); return; }
    saving = true;
    button.disabled = true;
    button.textContent = 'Saving…';
  });
  window.addEventListener('pageshow', () => {
    saving = false;
    button.disabled = false;
    button.textContent = 'Save themes';
  });
  document.querySelector('#form-error')?.focus();
}
