const panel = document.querySelector('#selection-panel');
if (panel) {
  const form = document.querySelector('#selection-form');
  const assignment = document.querySelector('#assignment-form');
  const boxes = [...document.querySelectorAll('.joke-select input')];
  const pageIds = [...form.querySelectorAll('input[name="pageIds"]')].map(input => input.value);
  const csrf = form.querySelector('input[name="csrf"]').value;
  const error = document.querySelector('#selection-error');
  const target = document.querySelector('#assignment-target');
  const name = document.querySelector('#new-deck-name');
  let selection = { ids: JSON.parse(panel.dataset.selectedIds), staleIds: JSON.parse(panel.dataset.staleIds) };
  let busy = false;
  let applying = false;
  let pending = Promise.resolve(true);

  function draw() {
    const hidden = selection.ids.filter(id => !pageIds.includes(id)).length;
    document.querySelector('#selection-summary').textContent = `${selection.ids.length} selected. ${hidden} hidden on other pages or by current filters.${busy ? ' Saving selection…' : ''}`;
    const stale = document.querySelector('#stale-selection');
    stale.hidden = selection.staleIds.length === 0;
    stale.textContent = `${selection.staleIds.length} selected jokes were deleted. Remove deleted selections or clear the selection before assigning.`;
    panel.setAttribute('aria-busy', String(busy));
    for (const box of boxes) { box.checked = selection.ids.includes(box.value); box.disabled = busy; }
    document.querySelector('#select-page').disabled = busy || !pageIds.length;
    document.querySelector('#clear-selection').disabled = busy || !selection.ids.length;
    document.querySelector('#prune-selection').hidden = !selection.staleIds.length;
    document.querySelector('#prune-selection').disabled = busy;
    document.querySelector('#apply-deck').disabled = !selection.ids.length;
    const expected = document.querySelector('#expected-selection');
    expected.replaceChildren();
    for (const id of selection.ids) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = 'expectedIds'; input.value = id;
      expected.append(input);
    }
  }
  function save(action) {
    const focused = document.activeElement;
    const selectedIds = boxes.filter(box => box.checked).map(box => box.value);
    error.textContent = '';
    busy = true;
    // Keep the user's check visible while saving; draw() reconciles afterward.
    for (const box of boxes) box.disabled = true;
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    document.querySelector('#selection-summary').textContent += ' Saving selection…';
    pending = (async () => {
      try {
        const response = await fetch('/admin/selection', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ action, pageIds, selectedIds }) });
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Selection could not be saved. Reload the page and sign in again if needed.');
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Selection could not be saved. Try again.');
        selection = result;
        return true;
      } catch (problem) {
        error.textContent = `${problem.message} Reload to review your saved selection, or retry.`;
        return false;
      } finally {
        busy = false; draw();
        if (document.activeElement === document.body && focused instanceof HTMLElement) {
          (focused.disabled ? document.querySelector('#selection-summary') : focused).focus();
        }
      }
    })();
    return pending;
  }
  for (const box of boxes) box.addEventListener('change', () => { if (!busy) save('page'); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!busy) save(event.submitter?.value ?? 'page');
  });
  for (const other of document.querySelectorAll('form:not(#selection-form)')) other.addEventListener('submit', async event => {
    if (!busy) return;
    event.preventDefault();
    const submitter = event.submitter;
    if (await pending) other.requestSubmit(submitter);
  });
  document.addEventListener('click', async event => {
    const link = event.target.closest('a');
    if (!link || !busy || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (await pending) window.location.assign(link.href);
  });
  function toggleName() {
    const creating = target.value === 'new';
    document.querySelector('#new-deck-field').hidden = !creating;
    name.disabled = !creating;
    name.required = creating;
  }
  target.addEventListener('change', toggleName);
  assignment.addEventListener('submit', event => {
    if (busy || applying || !assignment.reportValidity()) { event.preventDefault(); return; }
    applying = true;
    document.querySelector('#apply-deck').disabled = true;
  });
  window.addEventListener('pageshow', async event => {
    if (!event.persisted) return;
    applying = false;
    try {
      const response = await fetch('/admin/selection', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      selection = await response.json(); draw();
    } catch { error.textContent = 'Refresh the page to reload your saved selection.'; }
  });
  document.querySelector('#save-selection').hidden = true;
  toggleName(); draw();
  document.querySelector('#form-error')?.focus();
}
