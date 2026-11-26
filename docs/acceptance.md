# Local release acceptance

Run these checks locally. There are no GitHub Actions validation jobs, and no
development images are published. The owner runs the complete suite and final
golden path; implementation work runs only focused checks for changed behavior.
Record source/image digests and actual outcomes rather than treating a prepared
checklist as a passing release.

## Compiled-server HTTP check

```sh
pnpm test:acceptance
```

The two focused tests compile the production server/assets, start real Node
HTTP listeners and temporary PostgreSQL, and use real form/HTTP requests. They
do not inject requests into the application handlers. No Docker daemon is
needed. `TEST_DATABASE_URL` can supply a dedicated PostgreSQL instance instead;
each test owns only its random schema. The supplied server is never stopped.

The harness captures the generated first-start key from the child process's
stdout in memory and never echoes it, cookies or CSRF fields. It tests:

1. No-theme single joke, reusable existing/new themes on a two-part joke, and a
   third joke under another theme, preserving Unicode/quotes/backslashes/lines.
2. Key-only login, every collected joke/filter, cross-page selection and a shared
   multi-theme joke counted once. Twenty-six unassigned pagination fillers are
   seeded directly in the disposable database; all product operations use HTTP.
3. Atomic create/assign, moving a joke to a second deck, an empty deck, and exact
   schema-validated selected/all-deck downloads independent of theme filters.
4. Rename with stable ID, theme deletion/public choices, joke deletion, and
   populated-deck deletion preserving unassigned joke text and remaining themes.
5. Recreated server, retained database/key/export, operator rotation and session
   expiry/revocation, without exposing generated credentials in test output.
6. Blank/oversized input, concurrent equivalent themes, stale joke/target
   conflicts without partial deck writes, CSRF/admin protection and forged
   forwarding headers that cannot reset the default rate limit.

Teardown stops the child server, closes pools, removes only the random schemas
and stops/removes temporary PostgreSQL. HTTP helpers accept only loopback test
origins. They are not a command for exercising an existing production site.

## Production image and disposable Compose check

Build the current Dockerfile locally and exercise its runtime image:

```sh
pnpm test:compose
```

To exercise a published release instead, set an explicit version/digest:

```sh
COLLECTOR_CHECK_IMAGE=ghcr.io/kihiralove/osrs-jokes-collector@sha256:f076a0b1af3f117f839269d2374031ae8910d1ccfab05a00c38366d1a39abe80 pnpm test:compose
```

This pulls the chosen release without building a replacement. The published
image is retained afterward. Without that setting, a uniquely named local image
is built and removed by the harness; neither mode pushes anything.

The stack uses `compose.yaml` plus `compose.acceptance.yaml`. The latter adds
only disposable loopback ingress and its matching HTTP admin origin, leaving
production images, volume ownership, secret bootstrap, private PostgreSQL,
read-only filesystems and readiness checks intact. It deliberately does not
join the live Traefik network or claim to verify Cloudflare/TLS; those are the
[separate infrastructure checks](proxy.md#live-verification).

From empty disposable volumes, the Docker check runs the same HTTP golden path,
then verifies container recreation, key/password/session persistence, safe
missing/corrupt/mismatched-secret failures and real PostgreSQL backup/restore
into fresh volumes. The restored collection must log in and export the exact
same deck IDs/names/text, including its deletion/unassignment results. It checks
non-root ownership, read-only secret mounts, no PostgreSQL host port, disabled
bootstrap networking and absence of dev-only dependencies in the runtime image.
Credentials stay in runtime volumes/memory and are never copied into build input.

Each run uses a random project prefix and loopback port, deletes only its own
containers/networks/volumes, and removes only an image it built itself. It needs
Docker access and Node/pnpm dependencies on the host. Do not combine the test
override with production or reuse its HTTP origin for live deployment.

## Coverage and focused commands

```sh
pnpm typecheck
pnpm build
pnpm test:acceptance
node --test --test-isolation=none test/proxy.test.ts
node --test --test-isolation=none test/release.test.ts
pnpm fixtures:check
```

Existing focused suites provide deeper edge-case coverage:

| Area | Local test file |
| --- | --- |
| Submission bounds, Unicode and theme/input behavior | `test/submission.test.ts`, `test/normalization.test.ts` |
| Concurrent themes, constraints, migration checks and rollback | `test/database.test.ts` |
| Login/session expiry, logout/rotation, CSRF and protected routes | `test/admin.test.ts` |
| Theme/joke deletion, empty filters and pagination precision | `test/moderation.test.ts` |
| Bulk selection, invalid targets and atomic deck actions | `test/decks.test.ts` |
| Export schema, ordering, escaping, empty/unassigned decks and rename | `test/export.test.ts` |
| Trusted IPv4/IPv6 forwarding chain, spoofing and cache policy | `test/proxy.test.ts` |
| Release tag/source/approval restrictions | `test/release.test.ts` |

The owner runs the complete suite with `pnpm test` and the opt-in Docker check
with `pnpm test:compose`. Focused implementation checks do not replace them.

## Website browser checklist

Use a disposable local stack, not a live collection. Check at desktop width and
320px, with keyboard alone as well as pointer input:

- Switch Single joke/Two part joke without losing draft fields. Submit both;
  check blank/too-long errors retain the draft and identify the relevant field.
- Type a new theme, select an existing suggestion, open the complete catalog,
  add/remove multiple themes, and submit without any theme. Check labels, focus,
  live feedback and no horizontal overflow.
- Log in by key, browse/filter themes, select across older/newer pages and other
  themes, verify total/hidden counts, then create a deck, move and unassign jokes.
- Rename/delete with confirmation/cancel, download selected/all decks, log out,
  and confirm protected pages cannot be revisited with a valid session.
- With JavaScript disabled, use Update joke type/Update selection and the native
  theme checkboxes/new-theme textarea before navigating or submitting.

Earlier UI checks in collector PRs #17/#18 exercised cross-theme/page selection,
create/move/unassign, keyboard focus, native export-form errors and 320px layout.
The [final local browser record](release-records/v0.1.0-browser.md) documents
the pass on merged PR #21, including its script-disabled/browser-download
capture limits. API tests alone do not establish selector accessibility or
browser download behavior.

## Short release runbook

1. Owner: run the full local suite, Docker golden path and browser checklist for
   the exact main commit. Check [fixture compatibility](plugin-compatibility.md).
2. Bump `package.json` through a PR for changed release source, create its matching
   stable tag, then manually dispatch [release-image.yaml](../.github/workflows/release-image.yaml)
   from main as described in [releases.md](releases.md). Never move an old tag.
3. Verify anonymous image access, record the immutable digest and test it using
   `COLLECTOR_CHECK_IMAGE`. Snapshot the existing database/secrets before upgrade.
4. Deploy the digest with the configured Traefik labels/public origin/trust
   chain. Startup applies checksum-verified migrations before readiness. Obtain
   the first key from `dc logs app`; restarts never replace/reprint it.
5. Verify readiness, login, submissions and export through the actual proxy.
   Record [live HTTPS/cache/IP/origin-isolation checks](proxy.md#live-verification).
6. If rollback is needed after a schema change, restore the matching pre-upgrade
   database/secret backup into fresh volumes with its recorded app digest. Use
   [deployment.md](deployment.md) for the backup, restore and rotation commands.

Plugin UI/in-game confirmation is owner-managed and deferred in issue #9. The
actual codec fixture hashes/revisions are recorded in
[plugin-compatibility.md](plugin-compatibility.md); no RuneScape input is automated.
The owner has confirmed the full suite and published-image Compose check. Local
browser acceptance is recorded above. Live proxy verification remains deferred
in #10 until deployment; #1 also retains that gate and the owner-managed plugin
work in #9. Do not treat local acceptance as completion of those separate gates.
