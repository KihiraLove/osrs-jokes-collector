import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestDatabase {
  connectionString: string;
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local test database port.'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function startTestDatabase(connectionString = process.env.TEST_DATABASE_URL): Promise<TestDatabase> {
  if (connectionString) return { connectionString, close: async () => {} };

  // Load native test tooling only when an existing database was not supplied.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const useSocket = process.platform !== 'win32';
  const port = useSocket ? 5432 : await availablePort();
  const directory = await mkdtemp(join(tmpdir(), 'osrs-jokes-tests-'));
  const password = randomBytes(32).toString('hex');
  const cluster = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'collector_test',
    password,
    port,
    authMethod: 'scram-sha-256',
    persistent: false,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    postgresFlags: useSocket ? ['-h', '', '-k', directory] : ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await cluster.initialise();
    await cluster.start();
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Could not start temporary PostgreSQL. Run tests as your normal user, or set TEST_DATABASE_URL to an existing test database.', { cause });
  }

  const url = new URL(`postgresql://collector_test@127.0.0.1:${port}/postgres`);
  url.password = password;
  if (useSocket) url.searchParams.set('host', directory);
  let closed = false;
  return {
    connectionString: url.toString(),
    close: async () => {
      if (closed) return;
      closed = true;
      await cluster.stop();
    },
  };
}
