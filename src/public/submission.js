(() => {
  const form = document.querySelector('#joke-form');
  if (!form) return;
  const joke = document.querySelector('#joke-text');
  const punchline = document.querySelector('#punchline');
  const themeInput = document.querySelector('#theme-input');
  const newThemes = document.querySelector('#new-themes');
  const checkboxes = [...form.querySelectorAll('input[name="themes"]')];
  const selected = document.querySelector('#selected-themes');
  const feedback = document.querySelector('#theme-feedback');
  const submit = document.querySelector('#submit-joke');
  const maximum = Number(form.dataset.maxThemes);
  const partMaximum = Number(form.dataset.maxPartLength);
  const normalize = value => value.normalize('NFKC').replace(/[\p{White_Space}\uFEFF]+/gu, ' ').trim();
  const key = value => normalize(value).toLowerCase();
  let names = [];
  let sending = false;

  function toggleKind() {
    const twoPart = form.elements.kind.value === 'two_part';
    document.querySelector('#joke-text-label').textContent = twoPart ? 'Setup' : 'Joke';
    document.querySelector('#punchline-field').hidden = !twoPart;
    punchline.disabled = !twoPart;
    punchline.required = twoPart;
    if (!twoPart) punchline.setCustomValidity('');
  }
  function chosen() {
    return [...checkboxes.filter(box => box.checked).map(box => box.value), ...names];
  }
  function redraw() {
    newThemes.value = names.join('\n');
    const values = chosen();
    selected.hidden = values.length === 0;
    document.querySelector('#selected-count').textContent = `${values.length} of ${maximum} themes selected`;
    const list = selected.querySelector('ul');
    list.replaceChildren();
    for (const name of values) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remove-theme';
      button.textContent = `${name} ×`;
      button.setAttribute('aria-label', `Remove theme ${name}`);
      button.addEventListener('click', () => {
        const box = checkboxes.find(box => key(box.value) === key(name));
        if (box) box.checked = false;
        names = names.filter(value => key(value) !== key(name));
        feedback.textContent = '';
        redraw();
        themeInput.focus();
      });
      item.append(button);
      list.append(item);
    }
  }
  function addTheme() {
    const name = normalize(themeInput.value);
    feedback.textContent = '';
    if (!name) { themeInput.value = ''; return true; }
    if ([...name].length > 80 || name.includes('\0')) {
      feedback.textContent = 'A theme must contain 1–80 characters.';
      themeInput.focus();
      return false;
    }
    if (!chosen().some(value => key(value) === key(name))) {
      if (chosen().length >= maximum) {
        feedback.textContent = `Choose at most ${maximum} themes. Remove one before adding another.`;
        themeInput.focus();
        return false;
      }
      const box = checkboxes.find(box => key(box.value) === key(name));
      if (box) box.checked = true;
      else names.push(name);
    }
    themeInput.value = '';
    redraw();
    return true;
  }

  for (const value of newThemes.value.split(/\r?\n/u)) {
    if (!normalize(value)) continue;
    const box = checkboxes.find(box => key(box.value) === key(value));
    if (box) box.checked = true;
    else if (!names.some(name => key(name) === key(value))) names.push(value);
  }
  for (const box of checkboxes) box.addEventListener('change', () => {
    feedback.textContent = '';
    if (chosen().length > maximum && box.checked) {
      box.checked = false;
      feedback.textContent = `Choose at most ${maximum} themes.`;
    }
    redraw();
  });
  form.querySelectorAll('input[name="kind"]').forEach(radio => radio.addEventListener('change', toggleKind));
  document.querySelector('#add-theme').addEventListener('click', () => { if (addTheme()) themeInput.focus(); });
  themeInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addTheme(); }
  });
  for (const field of [joke, punchline]) field.addEventListener('input', () => field.setCustomValidity(''));
  form.addEventListener('submit', event => {
    if (sending || !addTheme()) { event.preventDefault(); return; }
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
  document.querySelector('#theme-entry').hidden = false;
  document.querySelector('#new-themes-field').hidden = true;
  toggleKind();
  redraw();
  document.querySelector('#form-error')?.focus();
})();
