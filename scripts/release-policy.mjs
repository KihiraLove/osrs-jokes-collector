import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Release integrity checks only. Software validation runs locally, not in Actions.
function fail(message) { throw new Error(message); }
const { GITHUB_REF, GITHUB_REPOSITORY, RELEASE_TAG, LOCAL_CHECKS_PASSED, GITHUB_OUTPUT } = process.env;
if (GITHUB_REF !== 'refs/heads/main' || GITHUB_REPOSITORY !== 'KihiraLove/osrs-jokes-collector') fail('Dispatch a release from the collector main branch.');
if (LOCAL_CHECKS_PASSED !== 'true') fail('Confirm local checks passed for the exact release commit.');
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(RELEASE_TAG ?? '')) fail('Use a stable release tag such as v0.1.0.');
if (!GITHUB_OUTPUT) fail('A release output file is required.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let revision;
let version;
try {
  revision = git('rev-parse', '--verify', `refs/tags/${RELEASE_TAG}^{commit}`);
  git('merge-base', '--is-ancestor', revision, 'origin/main');
  version = JSON.parse(git('show', `${revision}:package.json`)).version;
} catch { fail('The release tag must exist on main and contain package.json.'); }
if (`v${version}` !== RELEASE_TAG) fail('The release tag must match package.json version at that commit.');
const image = 'ghcr.io/kihiralove/osrs-jokes-collector';
appendFileSync(GITHUB_OUTPUT, `tag=${RELEASE_TAG}\nversion=${version}\nrevision=${revision}\nimage=${image}\n`);
console.log(`Publishing ${image}:${RELEASE_TAG} from ${revision}`);
