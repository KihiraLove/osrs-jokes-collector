import { bootstrapSecrets } from './runtime/secrets.ts';

try {
  const status = await bootstrapSecrets({
    secretsDirectory: process.env.COLLECTOR_SECRETS_DIR ?? '/run/collector-secrets',
    dataDirectory: process.env.COLLECTOR_DATA_DIR ?? '/postgres-data',
    uid: 1000,
    gid: 1000,
  });
  console.log(status === 'created' ? 'Generated initial database credentials.' : 'Reusing existing database credentials.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Database credential bootstrap failed.');
  process.exitCode = 1;
}
