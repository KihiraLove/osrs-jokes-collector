import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const script = fileURLToPath(new URL('../scripts/release-policy.mjs', import.meta.url));

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'collector-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => {
    git('add', 'package.json');
    git('-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'Release fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '--initial-branch=main');
  await writeFile(join(directory, 'package.json'), '{"version":"0.1.0"}\n');
  const revision = commit();
  git('update-ref', 'refs/remotes/origin/main', revision);
  git('-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'tag', '-a', 'v0.1.0', '-m', 'Release fixture');
  const output = join(directory, 'outputs');
  async function run(environment: NodeJS.ProcessEnv = {}) {
    await writeFile(output, '');
    const response = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: {
      ...process.env, GITHUB_REPOSITORY: 'KihiraLove/osrs-jokes-collector', GITHUB_REF: 'refs/heads/main',
      RELEASE_TAG: 'v0.1.0', LOCAL_CHECKS_PASSED: 'true', GITHUB_OUTPUT: output, ...environment,
    } });
    return { ...response, output: await readFile(output, 'utf8') };
  }
  return { git, commit, directory, revision, run };
}

test('release policy resolves a locally approved stable tag to its exact source commit and sole image tag', async context => {
  const f = await fixture(context);
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `tag=v0.1.0\nversion=0.1.0\nrevision=${f.revision}\nimage=ghcr.io/kihiralove/osrs-jokes-collector\n`);
});

test('release policy refuses branch/fork dispatches, missing local approval and development or injected tags', async context => {
  const f = await fixture(context);
  for (const environment of [
    { GITHUB_REF: 'refs/heads/codex/feature' }, { GITHUB_REF: 'refs/tags/v0.1.0' },
    { GITHUB_REPOSITORY: 'someone/collector' }, { LOCAL_CHECKS_PASSED: 'false' },
    ...['latest', 'main', 'sha-deadbeef', 'v0.1.0-dev', 'v0.1.0+build', 'v01.1.0', 'v0.1.0\nimage=evil', 'v0.1.0;false'].map(RELEASE_TAG => ({ RELEASE_TAG })),
  ]) {
    const result = await f.run(environment);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '', 'Rejected inputs must not produce publication metadata.');
  }
});

test('release policy refuses missing tags, version mismatches and tags outside main history', async context => {
  const f = await fixture(context);
  assert.notEqual((await f.run({ RELEASE_TAG: 'v9.9.9' })).status, 0);
  f.git('tag', 'v0.2.0');
  const mismatch = await f.run({ RELEASE_TAG: 'v0.2.0' });
  assert.notEqual(mismatch.status, 0);
  assert.equal(mismatch.output, '');
  f.git('checkout', '-b', 'unmerged');
  await writeFile(join(f.directory, 'package.json'), '{"version":"1.0.0"}\n');
  f.commit();
  f.git('tag', 'v1.0.0');
  const unmerged = await f.run({ RELEASE_TAG: 'v1.0.0' });
  assert.notEqual(unmerged.status, 0);
  assert.equal(unmerged.output, '');
});
