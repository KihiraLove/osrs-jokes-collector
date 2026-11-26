import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';

type Fields = Record<string, string | string[]>;
interface ExportDocument { decks: { id: string; name: string; jokes: string[] }[] }
export interface CollectionSnapshot {
  exported: ExportDocument;
  deletedDeck: string;
  deletedJoke: string;
  preservedJoke: string;
  preservedText: string;
  preservedTheme: string;
  removedTheme: string;
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export const cardIds = (html: string) => [...html.matchAll(/data-joke-id="([a-f0-9-]+)"/g)].map(match => match[1]!);
const cards = (html: string) => [...html.matchAll(/<article class="joke-card"[^>]*data-joke-id="([a-f0-9-]+)"[^>]*>([\s\S]*?)<\/article>/g)];

export function hiddenField(html: string, name: string): string {
  const value = html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
  assert.ok(value !== undefined, `Expected ${name} field.`);
  return value;
}

// The harness accepts only its own loopback listener, never a public URL.
// Response bodies, cookies and generated keys must not become assertion output.
function checkOrigin(origin: string): void {
  const url = new URL(origin);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && url.port && !url.search && !url.hash);
}
export function acceptanceClient(origin: string) {
  checkOrigin(origin);
  let cookie = '';
  let csrf = '';
  async function request(path: string, fields?: Fields, expected = 200, options: { anonymous?: boolean; headers?: Record<string, string> } = {}) {
    assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Expected a relative test endpoint.');
    assert.equal(new URL(path, origin).origin, origin, 'Acceptance requests must stay on their loopback origin.');
    const body = new URLSearchParams();
    for (const [name, values] of Object.entries(fields ?? {})) for (const value of typeof values === 'string' ? [values] : values) body.append(name, value);
    if (fields && csrf && !options.anonymous) body.set('csrf', csrf);
    const response = await fetch(`${origin}${path}`, { method: fields ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { ...(cookie && !options.anonymous ? { Cookie: cookie } : {}), ...(fields ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...options.headers },
      ...(fields ? { body } : {}),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${fields ? 'POST' : 'GET'} ${path}: unexpected status.`);
    if (path.startsWith('/admin') && !options.anonymous) {
      const token = text.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
      if (token) csrf = token;
    }
    return { response, text };
  }
  return {
    request,
    get cookie() { return cookie; },
    async page(path: string, expected = 200) { return (await request(path, undefined, expected)).text; },
    async post(path: string, fields: Fields = {}, expected = 303) { return request(path, fields, expected); },
    async login(key: string, expected = 303) {
      cookie = '';
      csrf = '';
      const challenge = await request('/admin');
      assert.ok(challenge.text.includes('name="key"') && !challenge.text.includes('name="username"'), 'Login uses only the generated key.');
      cookie = challenge.response.headers.getSetCookie()[0]!.split(';')[0]!;
      const result = await request('/admin/login', { key }, expected);
      if (expected === 303) {
        const header = result.response.headers.getSetCookie()[0]!;
        assert.ok(header.includes('HttpOnly') && header.includes('SameSite=Strict'), 'Expected protected session cookie.');
        cookie = header.split(';')[0]!;
        await request('/admin/jokes');
      }
    },
  };
}

function jokeId(html: string, text: string): string {
  const card = cards(html).find(card => card[2]!.includes(escape(text)));
  assert.ok(card, 'Expected the submitted joke in the admin listing.');
  return card[1]!;
}
function namedId(html: string, name: string): string {
  const match = [...html.matchAll(/<option value="([a-f0-9-]{36})"[^>]*>([^<]*)<\/option>/g)]
    .find(match => match[2] === escape(name) || match[2]!.startsWith(`${escape(name)} (`));
  assert.ok(match, 'Expected named theme/deck in the current choices.');
  return match[1]!;
}

export async function verifyCollection(origin: string, key: string, seedPagination: (prefix: string) => Promise<void>): Promise<CollectionSnapshot> {
  const client = acceptanceClient(origin);
  const prefix = `Acceptance ${randomUUID()}`;
  const existing = `${prefix} Existing`;
  const added = `${prefix} New`;
  const different = `${prefix} Different`;
  const single = `A "bank" joke \\ 🦀\nA second line.`;
  const setup = 'Why did the crab cross the shore?';
  const punchline = 'To say 你好, café! 🦀\nThen scuttle away.';
  const other = 'Keep // this and /* that */ as text.';
  const firstName = `${prefix} A deck`;
  const secondName = `${prefix} B deck`;
  const renamed = `${prefix} A renamed deck`;
  const validator = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  validator.post('/check', { schema: { body: JSON.parse(await readFile(new URL('../../docs/decks.schema.json', import.meta.url), 'utf8')) } }, async (_request, reply) => reply.code(204).send());
  async function exported(ids?: string[], theme?: string): Promise<ExportDocument> {
    const result = await client.post('/admin/export', { scope: ids ? 'selected' : 'all', ...(ids ? { deckIds: ids } : {}), ...(theme ? { theme } : {}) }, 200);
    assert.equal(result.response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(result.response.headers.get('content-disposition'), 'attachment; filename="decks.json"');
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    const data = JSON.parse(result.text) as ExportDocument;
    assert.equal((await validator.inject({ method: 'POST', url: '/check', payload: data })).statusCode, 204, 'Export must match the published schema.');
    return data;
  }
  try {
    await client.login(key);
    assert.ok((await client.page('/admin/jokes')).includes('No jokes have been collected yet.'), 'Acceptance needs an empty disposable collection.');
    await client.post('/', { kind: 'single', text: single });
    let listing = await client.page('/admin/jokes');
    const first = jokeId(listing, single);
    assert.ok(listing.includes('Themes: No theme'), 'A single joke can have no theme.');
    // Establish a reusable, unused theme through normal moderation, then remove
    // that joke's link so the initial no-theme behavior is retained.
    await client.post(`/admin/jokes/${first}/themes`, { newThemes: existing });
    await client.post(`/admin/jokes/${first}/themes`, {});
    assert.ok((await client.page('/')).includes(escape(existing)), 'The public catalog includes unused themes.');
    await client.post('/', { kind: 'two_part', text: setup, punchline, themes: existing, newThemes: added });
    await client.post('/', { kind: 'single', text: other, newThemes: different });
    listing = await client.page('/admin/jokes');
    const second = jokeId(listing, setup);
    const third = jokeId(listing, other);
    assert.equal(cardIds(listing).length, 3);
    const themeA = namedId(listing, existing);
    const themeNew = namedId(listing, added);
    const themeB = namedId(listing, different);
    assert.deepEqual(cardIds(await client.page(`/admin/jokes?theme=${themeA}`)), [second]);
    assert.deepEqual(cardIds(await client.page(`/admin/jokes?theme=${themeB}`)), [third]);

    // Only pagination filler is seeded directly; all product operations use HTTP.
    await seedPagination(prefix);
    const newest = await client.page('/admin/jokes?theme=none');
    const olderUrl = newest.match(/rel="next" href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(olderUrl, 'Expected a second page of unthemed jokes.');
    const older = await client.page(olderUrl);
    assert.ok(cardIds(older).includes(first), 'The original no-theme joke is on the older page.');
    await client.post('/admin/selection', { action: 'page', pageIds: cardIds(older), selectedIds: [first] });
    for (const theme of [themeA, themeNew, themeB]) {
      const page = await client.page(`/admin/jokes?theme=${theme}`);
      await client.post('/admin/selection', { action: 'page', pageIds: cardIds(page), selectedIds: cardIds(page) });
    }
    const selected = JSON.parse(await client.page('/admin/selection')).ids as string[];
    assert.deepEqual(new Set(selected), new Set([first, second, third]), 'Cross-page and cross-theme selection counts shared jokes once.');
    await client.post('/admin/assign', { target: 'new', name: firstName, expectedIds: selected });
    assert.deepEqual(JSON.parse(await client.page('/admin/selection')).ids, []);
    listing = await client.page('/admin/jokes');
    const firstDeck = namedId(listing, firstName);
    await client.post('/admin/decks', { name: secondName });
    const secondDeck = namedId(await client.page('/admin/jokes'), secondName);
    assert.deepEqual(await exported([secondDeck]), { decks: [{ id: secondDeck, name: secondName, jokes: [] }] });
    const thirdPage = await client.page(`/admin/jokes?theme=${themeB}`);
    await client.post('/admin/selection', { action: 'page', pageIds: cardIds(thirdPage), selectedIds: [third] });
    await client.post('/admin/assign', { target: secondDeck, expectedIds: [third] });
    assert.deepEqual(await exported([firstDeck, secondDeck], themeA), { decks: [
      { id: firstDeck, name: firstName, jokes: [single, `${setup}\n\n${punchline}`] },
      { id: secondDeck, name: secondName, jokes: [other] },
    ] });
    assert.deepEqual(await exported(undefined, themeA), await exported([secondDeck, firstDeck]));
    await client.post(`/admin/decks/${firstDeck}/rename`, { name: renamed });
    const deletion = await client.page(`/admin/themes/${themeNew}/delete`);
    await client.post(`/admin/themes/${themeNew}/delete`, { confirmation: 'delete', expectedUsage: hiddenField(deletion, 'expectedUsage') });
    assert.ok(!(await client.page('/')).includes(escape(added)), 'Deleting a theme refreshes public choices.');
    const preserved = await client.page(`/admin/jokes/${second}/themes`);
    assert.ok(preserved.includes(escape(setup)) && preserved.includes(escape(existing)), 'Theme deletion preserves joke text and other links.');
    await client.post(`/admin/jokes/${second}/delete`, { confirmation: 'delete' });
    const deleteDeck = await client.page(`/admin/decks/${secondDeck}/delete`);
    await client.post(`/admin/decks/${secondDeck}/delete`, { confirmation: 'delete', expectedUsage: hiddenField(deleteDeck, 'expectedUsage') });
    const snapshot: CollectionSnapshot = { exported: { decks: [{ id: firstDeck, name: renamed, jokes: [single] }] }, deletedDeck: secondDeck, deletedJoke: second, preservedJoke: third, preservedText: other, preservedTheme: different, removedTheme: added };
    assert.deepEqual(await exported(), snapshot.exported);
    await verifyCollectionSnapshot(origin, client.cookie, snapshot);
    await client.post('/admin/logout');
    await client.request('/admin/export', undefined, 401);
    return snapshot;
  } finally { await validator.close(); }
}

export async function verifyCollectionSnapshot(origin: string, cookie: string, state: CollectionSnapshot): Promise<void> {
  checkOrigin(origin);
  const request = async (path: string, fields?: Fields, expected = 200) => {
    const response = await fetch(`${origin}${path}`, { method: fields ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: {
      Cookie: cookie, ...(fields ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    }, ...(fields ? { body: new URLSearchParams(fields as Record<string, string>) } : {}) });
    const text = await response.text();
    assert.equal(response.status, expected, 'Persisted collection endpoint status.');
    return text;
  };
  const exportPage = await request('/admin/export');
  const data = JSON.parse(await request('/admin/export', { scope: 'all', csrf: hiddenField(exportPage, 'csrf') }));
  assert.deepEqual(data, state.exported, 'Restored/recreated collection exports identically.');
  await request(`/admin/jokes/${state.deletedJoke}/themes`, undefined, 404);
  await request(`/admin/decks/${state.deletedDeck}/rename`, undefined, 404);
  const unassigned = await request(`/admin/jokes/${state.preservedJoke}/themes`);
  assert.ok(unassigned.includes('Deck: Unassigned') && unassigned.includes(escape(state.preservedText)) && unassigned.includes(escape(state.preservedTheme)), 'Deck deletion preserves the unassigned joke and its theme.');
}
