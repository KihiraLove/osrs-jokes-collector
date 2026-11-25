import { enhanceThemePicker } from '/theme-picker.js';

(() => {
  const form = document.querySelector('#joke-form');
  if (!form) return;
  const joke = document.querySelector('#joke-text');
  const punchline = document.querySelector('#punchline');
  const picker = enhanceThemePicker(form);
  const submit = document.querySelector('#submit-joke');
  const partMaximum = Number(form.dataset.maxPartLength);
  let sending = false;

  function toggleKind() {
    const twoPart = form.elements.kind.value === 'two_part';
    document.querySelector('#joke-text-label').textContent = twoPart ? 'Setup' : 'Joke';
    document.querySelector('#punchline-field').hidden = !twoPart;
    punchline.disabled = !twoPart;
    punchline.required = twoPart;
    if (!twoPart) punchline.setCustomValidity('');
  }
  form.querySelectorAll('input[name="kind"]').forEach(radio => radio.addEventListener('change', toggleKind));
  for (const field of [joke, punchline]) field.addEventListener('input', () => field.setCustomValidity(''));
  form.addEventListener('submit', event => {
    if (sending || !picker.addPending()) { event.preventDefault(); return; }
    for (const field of [joke, punchline]) {
      if (!field.disabled && [...field.value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, '')].length > partMaximum) {
        field.setCustomValidity(`Use up to ${partMaximum.toLocaleString()} characters per joke part.`);
      }
    }
    if (!form.reportValidity()) { event.preventDefault(); return; }
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Submitting…';
  });
  window.addEventListener('pageshow', () => {
    sending = false;
    submit.disabled = false;
    submit.textContent = 'Submit joke';
    toggleKind();
  });
  toggleKind();
  document.querySelector('#form-error')?.focus();
})();
