# Publishing a release image

The release workflow publishes the single website/backend image at
`ghcr.io/kihiralove/osrs-jokes-collector`. Both the app and one-shot initializer
use it. The current build target is **Linux amd64**. PostgreSQL remains the
separate official image pinned by Compose.

The first release, [v0.1.0](release-records/v0.1.0.md), is published and its
manifest is anonymously readable. Its record contains the digest and the live
acceptance results still to perform. Use the [acceptance runbook](acceptance.md)
when preparing later releases.

Publication is a manual `workflow_dispatch` action from `main`. Branch pushes,
PRs and even version-tag pushes do not trigger a build or publication. There
are no GitHub Actions test/validation jobs. The release job checks its inputs,
tag ancestry and version before building; all software checks run locally.
Actions are pinned to verified upstream commit SHAs.

## Validate and tag locally

After merging the release changes, use the exact commit you intend to release:

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm test
pnpm test:compose
```

The owner runs these complete checks. During implementation, use focused tests
instead. The Compose check builds only a disposable local image; it publishes
nothing. No registry credentials are needed for local validation.

The first version is `0.1.0`. For later releases, commit the new
`package.json` version through a PR first. Create a matching stable tag on the
validated main commit:

```sh
git tag -a v0.1.0 -m 'Release v0.1.0'
git push origin v0.1.0
```

The example above describes the existing first release; do not recreate it.
Substitute the new package version for future releases. Keep version tags fixed.
Use a new version for changed source or a rebuilt
release. The workflow rejects development/prerelease/build suffixes, missing
tags, tags outside main, version mismatches, fork/branch dispatches and missing
confirmation of local checks. It publishes **only** `vX.Y.Z`, with no `latest`,
branch, PR or commit-only tags.

## Dispatch publication

In **Actions → Publish release image → Run workflow**, choose `main`, enter the
tag and confirm local checks passed for that exact commit. Equivalent CLI:

```sh
gh workflow run release-image.yaml --ref main -f tag=v0.1.0 -f local_checks_passed=true
```

The workflow uses its short-lived built-in `GITHUB_TOKEN` with `contents: read`
and `packages: write`; do not create a PAT or registry secret. It resolves the
tag's commit, builds that source and attaches OCI source, BSD-2-Clause license,
version and revision metadata. The run summary records the resulting digest.
GitHub documents [publishing with GITHUB_TOKEN](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

If an existing package was created outside this workflow, grant this repository
Actions access to it in the package settings before publishing. The OCI source
label and workflow token connect a newly created package to this repository.

## First publication: verify public visibility

GitHub creates a new personal container package as **private**, even when its
repository is public. Check anonymous access after publication. If the package
is private, the owner must open their GitHub profile's
**Packages → osrs-jokes-collector → Package settings
→ Change visibility → Public**, following
[GitHub's package-visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#configuring-visibility-of-packages-for-your-personal-account).
This one-time account setting is not provided by the workflow token. Skip it
when anonymous access already works, as verified for v0.1.0. Later versions
reuse the same public package.

Verify anonymous access with an empty Docker credential directory:

```sh
collector_pull_config="$(mktemp -d)"
docker --config "$collector_pull_config" pull ghcr.io/kihiralove/osrs-jokes-collector:v0.1.0
rm -rf "$collector_pull_config"
```

Do this on a clean host as well before calling the release deployable. A private
package or failed pull leaves release acceptance pending; do not work around it
by adding a deployment token/password to `.env`. Opening or merging the release
PR alone does not publish an image or change package visibility.

## Deploy and record the digest

Copy the complete digest reference from the successful run summary:

```sh
export COLLECTOR_IMAGE=ghcr.io/kihiralove/osrs-jokes-collector@sha256:REPLACE_WITH_RUN_DIGEST
```

Use the [production Compose instructions](deployment.md) with that value.
Record the digest with the release tag/source commit, Compose revision and a
matching database/secret backup. Version tags are convenient for discovery;
digest references identify the exact deployed image, including on rollback.
Do not use an untagged image reference, which implies `latest`.

After deployment, run the [live proxy checks](proxy.md#live-verification).
Publication/anonymous pull, a clean-host startup, and the actual
Cloudflare/Traefik results must be recorded separately from local tests. The
clean-host and live infrastructure checks remain pending until those operations
have been performed. Rollback/backup commands are in [deployment.md](deployment.md).
