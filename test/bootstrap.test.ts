import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { databaseConfig, startupFailureMessage } from '../src/runtime/database-config.ts';
import { bootstrapSecrets, PASSWORD_FILENAME, readGeneratedPassword } from '../src/runtime/secrets.ts';

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'collector-bootstrap-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, 'postgres');
  const secretsDirectory = join(root, 'secrets');
  await mkdir(dataDirectory);
  return { root, dataDirectory, secretsDirectory, passwordFile: join(secretsDirectory, PASSWORD_FILENAME) };
}

test('secret bootstrap publishes a complete credential atomically under concurrent starts', async context => {
  const options = await fixture(context);
  const results = await Promise.all(Array.from({ length: 8 }, () => bootstrapSecrets(options)));
  assert.equal(results.filter(result => result === 'created').length, 1);
  assert.match(await readGeneratedPassword(options.passwordFile), /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(options.secretsDirectory), [PASSWORD_FILENAME]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(options.secretsDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(options.passwordFile)).mode & 0o777, 0o600);
    assert.equal((await stat(options.passwordFile)).uid, process.getuid!());
  }
});

test('secret bootstrap preserves credentials after database initialization and repairs permissions', async context => {
  const options = await fixture(context);
  await bootstrapSecrets(options);
  const original = await readFile(options.passwordFile, 'utf8');
  await mkdir(join(options.dataDirectory, '18', 'docker'), { recursive: true });
  await writeFile(join(options.dataDirectory, '18', 'docker', 'PG_VERSION'), '18\n');
  await chmod(options.passwordFile, 0o644);
  assert.equal(await bootstrapSecrets(options), 'existing');
  assert.equal(await readFile(options.passwordFile, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal((await stat(options.passwordFile)).mode & 0o777, 0o600);
});

test('secret bootstrap refuses lost credentials when database data already exists', async context => {
  const options = await fixture(context);
  await writeFile(join(options.dataDirectory, 'PG_VERSION'), '18\n');
  await assert.rejects(bootstrapSecrets(options), /password is missing.*Restore/);
  await assert.rejects(stat(options.passwordFile), { code: 'ENOENT' });
  assert.deepEqual(await readdir(options.dataDirectory), ['PG_VERSION']);
});

test('secret bootstrap rejects corrupt credentials without replacing them', async context => {
  const options = await fixture(context);
  await mkdir(options.secretsDirectory);
  await writeFile(options.passwordFile, 'broken-password');
  await assert.rejects(bootstrapSecrets(options), /corrupt.*Restore/);
  assert.equal(await readFile(options.passwordFile, 'utf8'), 'broken-password');
  await writeFile(join(options.dataDirectory, 'PG_VERSION'), '18\n');
  await assert.rejects(bootstrapSecrets(options), /corrupt.*Restore/);
  assert.equal(await readFile(options.passwordFile, 'utf8'), 'broken-password');
});

test('secret bootstrap fails closed when its database volume is absent', async context => {
  const options = await fixture(context);
  await rm(options.dataDirectory, { recursive: true });
  await assert.rejects(bootstrapSecrets(options), { code: 'ENOENT' });
  await assert.rejects(stat(options.passwordFile), { code: 'ENOENT' });
});

test('secret bootstrap refuses symlinked password files', { skip: process.platform === 'win32' }, async context => {
  const options = await fixture(context);
  await mkdir(options.secretsDirectory);
  const target = join(options.root, 'outside-password');
  await writeFile(target, 'a'.repeat(64), { mode: 0o644 });
  await symlink(target, options.passwordFile);
  await assert.rejects(bootstrapSecrets(options), { code: 'ELOOP' });
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('database configuration reads generated password files and preserves local URL support', async context => {
  const options = await fixture(context);
  await bootstrapSecrets(options);
  assert.deepEqual(await databaseConfig({ PGPASSWORD_FILE: options.passwordFile }), { password: await readGeneratedPassword(options.passwordFile) });
  const connectionString = 'postgresql://localhost/local_database';
  assert.deepEqual(await databaseConfig({ DATABASE_URL: connectionString }), { connectionString });
  assert.deepEqual(await databaseConfig({}), {});
  await assert.rejects(databaseConfig({ PGPASSWORD_FILE: options.passwordFile, DATABASE_URL: connectionString }), /without DATABASE_URL or PGPASSWORD/);
  await assert.rejects(databaseConfig({ PGPASSWORD_FILE: options.passwordFile, PGPASSWORD: 'conflicting' }), /without DATABASE_URL or PGPASSWORD/);
  await assert.rejects(databaseConfig({ PGPASSWORD_FILE: join(options.root, 'missing') }), /Restore.*backup/);
});

test('database authentication failures give recovery instructions without exposing credentials', () => {
  const message = startupFailureMessage({ code: '28P01', message: 'private-password' });
  assert.match(message, /Database authentication failed.*Restore/);
  assert.ok(!message.includes('private-password'));
  assert.match(startupFailureMessage({ code: '28000' }), /Restore/);
  assert.match(startupFailureMessage(new Error('private-password')), /Check database connectivity/);
});
