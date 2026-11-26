import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { createPool } from '../src/db/database.ts';
import { secretDigest } from '../src/admin/store.ts';
import { startTestDatabase } from './helpers/database.ts';
import type { TestDatabase } from './helpers/database.ts';
import { acceptanceClient, cardIds, verifyCollection, verifyCollectionSnapshot } from './helpers/acceptance.ts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
describe('production server HTTP acceptance', () => {
  let database: TestDatabase;
  let maintenance: Pool;
  before(async () => {
    await execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root });
    await execute(process.execPath, ['scripts/copy-assets.mjs'], { cwd: root });
    database = await startTestDatabase();
    maintenance = createPool({ connectionString: database.connectionString });
  });
  after(async () => { try { await maintenance?.end(); } finally { await database?.close(); } });

  async function fixture(context: TestContext) {
    const schema = `acceptance_${randomUUID().replaceAll('-', '')}`;
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
    const port = await new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        assert.ok(address && typeof address !== 'string');
        listener.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: database.connectionString, PGOPTIONS: `-c search_path=${schema}`,
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin, ALLOW_INSECURE_LOCAL_ADMIN: 'true', TRUSTED_PROXY_CIDRS: '' };
    delete environment.PGPASSWORD_FILE;
    delete environment.PGPASSWORD;
    let current: { process: ReturnType<typeof spawn>; output: string } | undefined;
    let key = '';
    async function stop() {
      const child = current?.process;
      if (!child || child.exitCode !== null || !child.pid) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Acceptance server shutdown timed out.')); }, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    context.after(async () => {
      try { await stop(); await pool.end(); }
      finally { await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`); }
    });
    async function start(initial = false) {
      const instance = { process: spawn(process.execPath, ['dist/server.js'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }), output: '' };
      current = instance;
      instance.process.stdout!.on('data', data => { instance.output += data.toString(); });
      instance.process.stderr!.on('data', data => { instance.output += data.toString(); });
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (Date.now() < deadline && instance.process.exitCode === null) {
        try {
          const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(300) });
          await response.text();
          if (response.status === 200) { ready = true; break; }
        } catch { /* Wait for the new process's listener. */ }
        await delay(25);
      }
      assert.ok(ready, 'Compiled production server must become ready; captured output is kept private.');
      const keys = [...instance.output.matchAll(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/gm)];
      assert.equal(keys.length, initial ? 1 : 0, 'Only first startup prints a generated key.');
      if (initial) key = keys[0]![1]!;
    }
    await start(true);
    return { origin, pool, key, environment, stop, start };
  }

  test('golden path uses real HTTP and the compiled server, then survives restart and key rotation', async context => {
    const f = await fixture(context);
    const snapshot = await verifyCollection(f.origin, f.key, async prefix => {
      await f.pool.query("INSERT INTO jokes (kind, text) SELECT 'single', $1 || ' pagination ' || i FROM generate_series(1, 26) i", [prefix]);
    });
    await f.stop();
    await f.start();
    const restored = acceptanceClient(f.origin);
    await restored.login(f.key);
    await verifyCollectionSnapshot(f.origin, restored.cookie, snapshot);
    const rotation = await execute(process.execPath, ['dist/admin-key.js', 'rotate'], { cwd: root, env: f.environment, timeout: 10_000 })
      .catch(() => { throw new Error('Operator rotation failed; captured output is kept private.'); });
    const replacement = rotation.stdout.match(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/m)?.[1];
    assert.ok(replacement && replacement !== f.key, 'Rotation generates a distinct key without logging it.');
    await restored.request('/admin/export', undefined, 401);
    const next = acceptanceClient(f.origin);
    await next.login(f.key, 401);
    await next.login(replacement);
    await verifyCollectionSnapshot(f.origin, next.cookie, snapshot);
    const token = next.cookie.split('=')[1]!;
    await f.pool.query("UPDATE admin_sessions SET created_at = clock_timestamp() - INTERVAL '9 hours', expires_at = clock_timestamp() - INTERVAL '1 minute' WHERE token_hash = $1", [secretDigest(token)]);
    await next.request('/admin/export', undefined, 401);
  });

  test('real HTTP rejects invalid input, converges concurrent themes and preserves atomic stale selections', async context => {
    const f = await fixture(context);
    const client = acceptanceClient(f.origin);
    for (const path of ['/admin/jokes', '/admin/themes', '/admin/decks', '/admin/export', '/admin/selection']) await client.request(path, undefined, 401, { anonymous: true });
    await client.post('/', { kind: 'single', text: '\u0085\uFEFF' }, 422);
    await client.post('/', { kind: 'single', text: '🦀'.repeat(4_001) }, 422);
    await Promise.all([
      client.post('/', { kind: 'single', text: 'Concurrent A', newThemes: '  Ｓｋｉｌｌｉｎｇ  ' }),
      client.post('/', { kind: 'two_part', text: 'Concurrent B', punchline: 'Quote " \\ 🦀\nNew line', newThemes: 'skilling' }),
    ]);
    await client.post('/', { kind: 'two_part', text: 'Missing answer' }, 422);
    await client.request('/', { kind: 'single', text: 'Limited' }, 429, { headers: { 'x-forwarded-for': '198.51.100.99', 'cf-connecting-ip': '198.51.100.98' } });
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM themes')).rows[0].count, 1);
    await client.login(f.key);
    await client.request('/admin/decks', { name: 'Rejected' }, 403, { anonymous: true, headers: { Cookie: client.cookie } });
    const ids = cardIds(await client.page('/admin/jokes'));
    assert.equal(ids.length, 2);
    await client.post('/admin/selection', { action: 'page', pageIds: ids, selectedIds: ids });
    await client.post(`/admin/jokes/${ids[0]}/delete`, { confirmation: 'delete' });
    await client.post('/admin/assign', { target: 'new', name: 'Must roll back', expectedIds: ids }, 409);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM decks')).rows[0].count, 0);
    await client.post('/admin/selection', { action: 'prune' });
    await client.post('/admin/decks', { name: 'Deleted target' });
    const target = (await f.pool.query('SELECT id FROM decks')).rows[0].id as string;
    await client.post(`/admin/decks/${target}/delete`, { confirmation: 'delete', expectedUsage: '0' });
    await client.post('/admin/assign', { target, expectedIds: [ids[1]!] }, 409);
    assert.equal((await f.pool.query('SELECT deck_id FROM jokes')).rows[0].deck_id, null);
    await client.post('/admin/assign', { target: 'new', name: 'Recovered', expectedIds: [ids[1]!] });
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM decks')).rows[0].count, 1);
  });
});
