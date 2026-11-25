import { escapeHtml } from './html.ts';
export { escapeHtml } from './html.ts';

function page(content: string, wide = false, editor = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · OSRS Jokes</title><link rel="stylesheet" href="/styles.css">${editor ? '<script type="module" src="/theme-editor.js"></script>' : ''}</head>
<body><main${wide ? ' class="admin-main"' : ''}><h1>OSRS Jokes Admin</h1>${content}</main></body></html>`;
}

export function renderAdminPage(csrf: string, content: string, active: 'jokes' | 'themes' = 'jokes', editor = false): string {
  return page(`<div class="admin-toolbar"><nav aria-label="Admin">
<a href="/admin/jokes"${active === 'jokes' ? ' aria-current="page"' : ''}>Jokes</a>
<a href="/admin/themes"${active === 'themes' ? ' aria-current="page"' : ''}>Themes</a></nav>
<form class="logout" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Log out</button></form></div>${content}`, true, editor);
}

export function renderLogin(csrf: string, message = ''): string {
  return page(`${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/admin/login">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="admin-key">Admin key</label>
<input id="admin-key" name="key" type="password" autocomplete="current-password" maxlength="128" required>
<button type="submit">Log in</button></form>`);
}

export function renderAdmin(csrf: string): string {
  return page(`<p>Signed in.</p><form method="post" action="/admin/logout">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Log out</button></form>`);
}

export function renderAdminError(message: string): string {
  return page(`<p class="error" role="alert">${escapeHtml(message)}</p><p><a href="/admin">Return to admin</a></p>`);
}
