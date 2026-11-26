import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { verifyCollection, verifyCollectionSnapshot } from '../test/helpers/acceptance.ts';

// This opt-in check owns only the project/volumes named by its random prefix.
// It builds a local image or pulls an explicitly chosen published release.
// It never pushes images, changes production data or contacts GitHub Actions.
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `collector-check-${randomUUID().slice(0, 8)}`;
const releaseImage = process.env.COLLECTOR_CHECK_IMAGE;
if (releaseImage && !/^ghcr\.io\/kihiralove\/osrs-jokes-collector(?::v\d+\.\d+\.\d+|@sha256:[a-f0-9]{64})$/.test(releaseImage)) throw new Error('COLLECTOR_CHECK_IMAGE must name a published collector version or digest.');
const environment = {
  ...process.env,
  COLLECTOR_IMAGE: releaseImage ?? `osrs-jokes-collector:${project}`,
  COLLECTOR_PORT: '0',
};
const execute = promisify(execFile);
const prefix = ['compose', '--project-name', project, '-f', 'compose.yaml', '-f', 'compose.acceptance.yaml'];

async function docker(arguments_, { input, timeout = 60_000 } = {}) {
  const pending = execute('docker', arguments_, { cwd: root, env: environment, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout });
  pending.child.stdin.end(input);
  const { stdout } = await pending;
  return stdout;
}
const compose = (arguments_, options) => docker([...prefix, ...arguments_], options);
const text = buffer => buffer.toString('utf8').trim();
const up = () => compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'app'], { timeout: 180_000 });
const sql = query => compose(['exec', '-T', 'db', 'psql', '-U', 'collector', '-d', 'collector', '-v', 'ON_ERROR_STOP=1', '-Atc', query]);
const inspect = async service => JSON.parse(text(await docker(['inspect', text(await compose(['ps', '--all', '--quiet', service]))])))[0];
const runNode = source => compose(['run', '--rm', '--no-deps', '-T', 'bootstrap', '--input-type=module', '-e', source]);
const fingerprint = async () => text(await compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', `
  import { readFile, stat } from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  import assert from 'node:assert/strict';
  const file = '/run/collector-secrets/postgres-password';
  assert.equal(process.getuid(), 1000);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat('/run/collector-secrets')).mode & 0o777, 0o700);
  console.log(createHash('sha256').update(await readFile(file)).digest('hex'));
`]));
const restoreSecrets = archive => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'bootstrap', '-C', '/run/collector-secrets', '-xf', '-'], { input: archive });

async function localPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function adminKeyFromLogs() {
  const logs = text(await compose(['logs', '--no-color', '--no-log-prefix', 'app']));
  const matches = [...logs.matchAll(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/gm)];
  assert.equal(matches.length, 1, 'The initial admin key must be printed once.');
  return matches[0][1];
}
function sessionCookie(response) {
  const value = response.headers.getSetCookie().find(cookie => cookie.startsWith('osrs-jokes-admin-local='));
  assert.ok(value, 'Expected a local admin session cookie.');
  assert.ok(value.includes('HttpOnly'), 'Expected an HttpOnly session cookie.');
  assert.ok(value.includes('SameSite=Strict'), 'Expected a SameSite=Strict session cookie.');
  return value.split(';')[0];
}
function csrfField(body) {
  const match = body.match(/name="csrf" value="([a-f0-9]{64})"/);
  assert.ok(match, 'Expected an admin CSRF field.');
  return match[1];
}
async function adminChallenge(origin) {
  const response = await fetch(`${origin}/admin`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  return { cookie: sessionCookie(response), csrf: csrfField(await response.text()) };
}
async function adminLogin(origin, key) {
  const challenge = await adminChallenge(origin);
  const response = await fetch(`${origin}/admin/login`, { method: 'POST', redirect: 'manual', headers: {
    Origin: origin, Cookie: challenge.cookie, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ key, csrf: challenge.csrf }) });
  assert.equal(response.status, 303, 'Expected admin login to succeed.');
  const cookie = sessionCookie(response);
  assert.ok(cookie !== challenge.cookie, 'Login must rotate the session token.');
  return cookie;
}

let dockerAvailable = false;
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  dockerAvailable = true;
  if (releaseImage) {
    console.log('Pulling the selected published release image...');
    await docker(['pull', releaseImage], { timeout: 180_000 });
  } else {
    console.log('Building the local production application image...');
    await docker(['build', '--tag', environment.COLLECTOR_IMAGE, '.'], { timeout: 600_000 });
  }
  environment.COLLECTOR_PORT = String(await localPort());
  console.log('Starting an empty, isolated Compose project...');
  await up();
  const app = await inspect('app');
  const db = await inspect('db');
  const bootstrap = await inspect('bootstrap');
  assert.equal(app.Image, bootstrap.Image);
  assert.equal(app.Config.User, 'node');
  assert.equal(app.HostConfig.ReadonlyRootfs, true);
  assert.equal(app.Mounts.find(mount => mount.Destination === '/run/collector-secrets').RW, false);
  assert.equal(db.Mounts.find(mount => mount.Destination === '/run/collector-secrets').RW, false);
  assert.equal(bootstrap.HostConfig.NetworkMode, 'none');
  assert.ok(!db.NetworkSettings.Ports['5432/tcp']?.length);
  assert.ok(Object.values(app.NetworkSettings.Ports).flat().filter(Boolean).every(port => port.HostIp === '127.0.0.1'));
  const address = text(await compose(['port', 'app', '3000']));
  const origin = `http://${address}`;
  assert.equal((await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(3_000) })).status, 200);
  console.log('Checking initial admin key output and login...');
  const initialAdminKey = await adminKeyFromLogs();
  const authenticatedCookie = await adminLogin(origin, initialAdminKey);
  await compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    assert.throws(() => writeFileSync('/run/collector-secrets/postgres-password', 'must-not-write'), { code: 'EROFS' });
    for (const dependency of ['typescript', 'embedded-postgres']) {
      assert.throws(() => import.meta.resolve(dependency), { code: 'ERR_MODULE_NOT_FOUND' });
    }
  `]);
  const originalFingerprint = await fingerprint();
  console.log('Checking the public submission, moderation, selection and export golden path...');
  const snapshot = await verifyCollection(origin, initialAdminKey, async value => {
    await sql(`INSERT INTO jokes (kind, text) SELECT 'single', '${value.replaceAll("'", "''")} pagination ' || i FROM generate_series(1, 26) i`);
  });
  const verifyData = () => verifyCollectionSnapshot(origin, authenticatedCookie, snapshot);
  await compose(['stop', 'app']);
  const dump = await compose(['exec', '-T', 'db', 'pg_dump', '-U', 'collector', '-d', 'collector', '--format=custom']);
  const archive = await compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'bootstrap', '-C', '/run/collector-secrets', '-cf', '-', '.']);

  console.log('Checking container recreation, credentials and persisted data...');
  await compose(['down']);
  await up();
  assert.equal(await fingerprint(), originalFingerprint);
  await verifyData();
  assert.ok(!text(await compose(['logs', '--no-color', '--no-log-prefix', 'app'])).includes('OSRS_JOKES_ADMIN_KEY='), 'Restart must not print the existing key.');
  const resumedAdmin = await fetch(`${origin}/admin`, { headers: { Cookie: authenticatedCookie } });
  assert.ok((await resumedAdmin.text()).includes('action="/admin/logout"'), 'The authenticated session must survive container recreation.');

  for (const corruption of ['missing', 'corrupt']) {
    console.log(`Checking safe failure for ${corruption} credentials...`);
    await compose(['down']);
    await runNode(corruption === 'missing'
      ? "import { unlinkSync } from 'node:fs'; unlinkSync('/run/collector-secrets/postgres-password');"
      : "import { writeFileSync } from 'node:fs'; writeFileSync('/run/collector-secrets/postgres-password', 'broken');");
    await assert.rejects(compose(['run', '--rm', '--no-deps', '-T', 'bootstrap']), error => /Restore.*backup/.test(error.stderr?.toString() ?? ''));
    await restoreSecrets(archive);
    await up();
    assert.equal(await fingerprint(), originalFingerprint);
    await verifyData();
  }

  console.log('Checking recovery diagnostics for a valid-looking but incorrect password...');
  await compose(['down']);
  await runNode("import { randomBytes } from 'node:crypto'; import { writeFileSync } from 'node:fs'; writeFileSync('/run/collector-secrets/postgres-password', randomBytes(32).toString('hex'));");
  await compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'db'], { timeout: 180_000 });
  await assert.rejects(compose(['run', '--rm', '--no-deps', '-T', 'app']), error => /Database authentication failed.*Restore/.test(error.stdout?.toString() ?? ''));
  await compose(['down']);
  await restoreSecrets(archive);

  console.log('Restoring the backup into fresh test volumes...');
  await compose(['down', '--volumes']);
  await restoreSecrets(archive);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'db'], { timeout: 180_000 });
  await compose(['exec', '-T', 'db', 'pg_restore', '-U', 'collector', '-d', 'collector', '--clean', '--if-exists', '--no-owner', '--exit-on-error'], { input: dump });
  await up();
  assert.equal(await fingerprint(), originalFingerprint);
  await verifyData();
  console.log('Checking restored admin login and operator key rotation...');
  assert.ok(!text(await compose(['logs', '--no-color', '--no-log-prefix', 'app'])).includes('OSRS_JOKES_ADMIN_KEY='), 'Restoring a credential must not replace/reprint it.');
  const restoredCookie = await adminLogin(origin, initialAdminKey);
  await verifyCollectionSnapshot(origin, restoredCookie, snapshot);
  const rotation = text(await compose(['exec', '-T', 'app', 'node', 'dist/admin-key.js', 'rotate']));
  const rotatedKey = rotation.match(/^OSRS_JOKES_ADMIN_KEY=([a-f0-9]{64})$/m)?.[1];
  assert.ok(rotatedKey, 'Operator rotation must print the new admin key.');
  assert.ok(rotatedKey !== initialAdminKey, 'Rotation must replace the key.');
  const revoked = await fetch(`${origin}/admin`, { headers: { Cookie: restoredCookie } });
  assert.ok((await revoked.text()).includes('name="key"'), 'Key rotation must revoke the previous session.');
  const pending = await adminChallenge(origin);
  const rejected = await fetch(`${origin}/admin/login`, { method: 'POST', headers: {
    Origin: origin, Cookie: pending.cookie, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ key: initialAdminKey, csrf: pending.csrf }) });
  assert.equal(rejected.status, 401, 'The old admin key must stop working.');
  await adminLogin(origin, rotatedKey);
  console.log('Compose golden path, ownership, credentials, persistence, safe failures, backup/restore, exports and admin lifecycle checks passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (dockerAvailable) {
    await compose(['down', '--volumes', '--remove-orphans']).catch(error => {
      console.error(`Could not remove test project ${project}: ${error.message}`);
      process.exitCode = 1;
    });
    if (!releaseImage) await docker(['image', 'rm', environment.COLLECTOR_IMAGE]).catch(() => {});
  }
}
