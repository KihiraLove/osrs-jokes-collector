export function enhanceThemePicker(form) {
  const themeInput = form.querySelector('#theme-input');
  const newThemes = form.querySelector('#new-themes');
  const checkboxes = [...form.querySelectorAll('input[name="themes"]')];
  const selected = form.querySelector('#selected-themes');
  const feedback = form.querySelector('#theme-feedback');
  const maximum = Number(form.dataset.maxThemes);
  const normalize = value => value.normalize('NFKC').replace(/[\p{White_Space}\uFEFF]+/gu, ' ').trim();
  const key = value => normalize(value).toLowerCase();
  let names = [];

  function chosen() {
    return [...checkboxes.filter(box => box.checked).map(box => box.value), ...names];
  }
  function redraw() {
    newThemes.value = names.join('\n');
    const values = chosen();
    selected.hidden = values.length === 0;
    form.querySelector('#selected-count').textContent = `${values.length} of ${maximum} themes selected`;
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
  form.querySelector('#add-theme').addEventListener('click', () => { if (addTheme()) themeInput.focus(); });
  themeInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addTheme(); }
  });
  form.querySelector('#theme-entry').hidden = false;
  form.querySelector('#new-themes-field').hidden = true;
  redraw();
  return { addPending: addTheme };
}
