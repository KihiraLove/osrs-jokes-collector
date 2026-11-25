import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import type { DatabaseLifecycle } from '../src/db/database.ts';

test('readiness follows database availability and close releases database resources', async () => {
  let initialized = false;
  let available = true;
  let closed = 0;
  const database: DatabaseLifecycle = {
    initialize: async () => { initialized = true; },
    check: async () => { if (!available) throw new Error('private connection details'); },
    close: async () => { closed++; },
  };
  const app = createApp(database);
  try {
    assert.equal(initialized, false);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    assert.equal(initialized, true);
    available = false;
    const failed = await app.inject('/health/ready');
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { status: 'unavailable' });
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.equal((await app.inject('/health/live')).statusCode, 200);
  } finally {
    await app.close();
  }
  assert.equal(closed, 1);
});

test('a migration failure prevents startup and the pool can still be closed', async () => {
  let closed = false;
  const app = createApp({
    initialize: async () => { throw new Error('migration failed'); },
    check: async () => {},
    close: async () => { closed = true; },
  });
  await assert.rejects(async () => { await app.ready(); }, /migration failed/);
  await app.close();
  assert.equal(closed, true);
});

test('home and static stylesheet are served from the same application', async () => {
  const app = createApp({ initialize: async () => {}, check: async () => {}, close: async () => {} });
  try {
    const home = await app.inject('/');
    assert.equal(home.statusCode, 200);
    assert.match(home.headers['content-type']!, /text\/html/);
    assert.match(home.body, /href="\/styles.css"/);
    const styles = await app.inject('/styles.css');
    assert.equal(styles.statusCode, 200);
    assert.match(styles.headers['content-type']!, /text\/css/);
    assert.match(home.body, /src="\/submission.js"/);
    const script = await app.inject('/submission.js');
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type']!, /application\/javascript/);
  } finally {
    await app.close();
  }
});
