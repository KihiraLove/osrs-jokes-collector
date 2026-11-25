import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// This opt-in check owns only the project/volumes named by its random prefix.
// It builds a local image and never pushes images or contacts GitHub.
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `collector-check-${randomUUID().slice(0, 8)}`;
const environment = {
  ...process.env,
  COLLECTOR_IMAGE: `osrs-jokes-collector:${project}`,
  COLLECTOR_PORT: '0',
};
const execute = promisify(execFile);
const prefix = ['compose', '--project-name', project, '-f', 'compose.yaml', '-f', 'compose.local.yaml'];

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

const deckId = randomUUID();
const jokeId = randomUUID();
const verifyData = async () => assert.equal(text(await sql(`SELECT d.id || ':' || j.id FROM decks d JOIN jokes j ON j.deck_id = d.id WHERE d.id = '${deckId}'`)), `${deckId}:${jokeId}`);

let dockerAvailable = false;
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  dockerAvailable = true;
  console.log('Building the local application image...');
  await compose(['build', 'app'], { timeout: 600_000 });
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
  assert.equal((await fetch(`http://${address}/health/ready`, { signal: AbortSignal.timeout(3_000) })).status, 200);
  await compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    assert.throws(() => writeFileSync('/run/collector-secrets/postgres-password', 'must-not-write'), { code: 'EROFS' });
    for (const dependency of ['typescript', 'embedded-postgres']) {
      assert.throws(() => import.meta.resolve(dependency), { code: 'ERR_MODULE_NOT_FOUND' });
    }
  `]);
  const originalFingerprint = await fingerprint();
  await sql(`INSERT INTO decks (id, name, normalized_name) VALUES ('${deckId}', 'Compose check', 'compose check'); INSERT INTO jokes (id, kind, text, deck_id) VALUES ('${jokeId}', 'single', 'Persistence check', '${deckId}')`);
  await compose(['stop', 'app']);
  const dump = await compose(['exec', '-T', 'db', 'pg_dump', '-U', 'collector', '-d', 'collector', '--format=custom']);
  const archive = await compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'bootstrap', '-C', '/run/collector-secrets', '-cf', '-', '.']);

  console.log('Checking container recreation, credentials and persisted data...');
  await compose(['down']);
  await up();
  assert.equal(await fingerprint(), originalFingerprint);
  await verifyData();

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
  await up();
  await compose(['stop', 'app']);
  await compose(['exec', '-T', 'db', 'pg_restore', '-U', 'collector', '-d', 'collector', '--clean', '--if-exists', '--no-owner', '--exit-on-error'], { input: dump });
  await up();
  assert.equal(await fingerprint(), originalFingerprint);
  await verifyData();
  console.log('Compose startup, ownership, read-only secrets, persistence, safe failures and backup/restore checks passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (dockerAvailable) {
    await compose(['down', '--volumes', '--remove-orphans']).catch(error => {
      console.error(`Could not remove test project ${project}: ${error.message}`);
      process.exitCode = 1;
    });
    await docker(['image', 'rm', environment.COLLECTOR_IMAGE]).catch(() => {});
  }
}
