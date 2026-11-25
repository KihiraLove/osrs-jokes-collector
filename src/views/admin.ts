import { escapeHtml } from './html.ts';
export { escapeHtml } from './html.ts';

function page(content: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · OSRS Jokes</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><h1>OSRS Jokes Admin</h1>${content}</main></body></html>`;
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
