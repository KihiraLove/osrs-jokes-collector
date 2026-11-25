import { constants } from 'node:fs';
import { chmod, chown, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const PASSWORD_FILENAME = 'postgres-password';
export const RECOVERY_HINT = 'Restore the collector_secrets volume from a backup matching postgres_data; see docs/deployment.md. Existing database passwords are never regenerated automatically.';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function readGeneratedPassword(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error('The database password must be a regular file.');
    const value = await file.readFile('utf8');
    if (!/^[a-f0-9]{64}\n?$/.test(value)) throw new Error(`The database password file is corrupt. ${RECOVERY_HINT}`);
    return value.trimEnd();
  } finally {
    await file.close();
  }
}

interface BootstrapOptions {
  secretsDirectory: string;
  dataDirectory: string;
  uid?: number;
  gid?: number;
}

export async function bootstrapSecrets(options: BootstrapOptions): Promise<'created' | 'existing'> {
  const { secretsDirectory, dataDirectory, uid, gid } = options;
  // Fail closed if the database volume cannot be inspected. Never assume that
  // an absent mount is an empty database.
  const hasDatabaseData = (await readdir(dataDirectory)).some(name => name !== 'lost+found');
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(secretsDirectory)).isDirectory()) throw new Error('The secrets directory must not be a symbolic link.');
  await chmod(secretsDirectory, 0o700);
  if (uid !== undefined && gid !== undefined) await chown(secretsDirectory, uid, gid);

  const destination = join(secretsDirectory, PASSWORD_FILENAME);
  async function secureExistingPassword(): Promise<void> {
    await readGeneratedPassword(destination);
    await chmod(destination, 0o600);
    if (uid !== undefined && gid !== undefined) await chown(destination, uid, gid);
  }
  try {
    await secureExistingPassword();
    return 'existing';
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    if (hasDatabaseData) throw new Error(`The database password is missing but the database volume contains data. ${RECOVERY_HINT}`);
  }

  // Publish a complete, fsynced file with a no-overwrite hard link. Concurrent
  // initializers either win publication or reuse the winner's credential.
  const temporary = join(secretsDirectory, `.postgres-password-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${randomBytes(32).toString('hex')}\n`);
      await file.chmod(0o600);
      if (uid !== undefined && gid !== undefined) await file.chown(uid, gid);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
      if (process.platform !== 'win32') {
        const directory = await open(secretsDirectory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return 'created';
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      await secureExistingPassword();
      return 'existing';
    }
  } finally {
    await unlink(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
  }
}
