# Docker deployment and operations

Run these commands from the repository root with Docker Engine and Docker
Compose installed. The application image contains the compiled website/backend,
migrations, credential bootstrap/rotation commands and readiness check.
PostgreSQL uses the official `postgres:18.7-bookworm` image. The manually
triggered [release workflow](releases.md) publishes versioned application images
after the owner validates locally. See the [v0.1.0 record](release-records/v0.1.0.md)
for its published digest and the [acceptance runbook](acceptance.md) for pending
clean-host/live deployment checks.

## Local build

Define a helper so every command uses the same Compose files:

```sh
dc() { docker compose -f compose.yaml -f compose.local.yaml "$@"; }
dc up --build --detach --wait app
```

The app is at `http://127.0.0.1:3000`. Set `COLLECTOR_PORT` only if you need a
different localhost port. Both bootstrap and app use the same local image;
the database has no published port.

## Traefik and Cloudflare

Once a release is publicly pullable, set `COLLECTOR_IMAGE` to the digest recorded
in its workflow summary and define the production helper. Set the hostname and
trust list for the actual infrastructure; the image digest below is a placeholder:

```sh
export COLLECTOR_IMAGE=ghcr.io/kihiralove/osrs-jokes-collector@sha256:REPLACE_WITH_RUN_DIGEST
export COLLECTOR_HOSTNAME=jokes.example.com
# Set the actual Traefik IP plus current Cloudflare ranges using docs/proxy.md:
export TRUSTED_PROXY_CIDRS=REPLACE_WITH_REVIEWED_PROXY_CIDRS
dc() { docker compose -f compose.yaml -f compose.traefik.yaml "$@"; }
dc config --quiet
dc pull
dc up --detach --wait app
```

For a locally built image on the Docker host, build with the local override first
and set `COLLECTOR_IMAGE=osrs-jokes-collector:local` before using the production
helper. This also lets you verify the proxy wiring before release publication.

Routing is configured with the Docker labels in `compose.traefik.yaml`:
hostname, entrypoint, TLS, selected Docker network and app port 3000. The
hostname/network/entrypoint substitutions are operator conveniences; labels can
also be maintained in an infrastructure override. Keep `PUBLIC_ORIGIN` aligned
with the Host rule when editing it directly. The external network and HTTPS
certificate must already exist in Traefik. Only the app joins the proxy network;
the production stack exposes no host ports and keeps the database private.

Follow [proxy configuration](proxy.md) for Cloudflare Full (strict), the complete
trusted forwarding chain, origin firewall/authentication, cache bypass and live
checks. The Traefik override requires explicit proxy trust; outside it,
forwarded headers stay untrusted by default. Do not combine the production and
local overrides.

## Settings and stored data

| Setting | Default | Use |
| --- | --- | --- |
| `COLLECTOR_IMAGE` | GHCR `v0.1.0` in the base stack; `osrs-jokes-collector:local` locally | Use a publicly published release digest in production |
| `COLLECTOR_HOSTNAME` | Required only by the Traefik override | Public hostname |
| `TRAEFIK_NETWORK` | `traefik` | Existing proxy network |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Existing HTTPS entrypoint, substituted into the router label |
| `COLLECTOR_PORT` | `3000` | Local override's localhost port |
| `COMPOSE_PROJECT_NAME` | `osrs-jokes-collector` | Optional isolated deployment name |
| `TRUSTED_PROXY_CIDRS` | Required by Traefik override; empty elsewhere | Actual stable Traefik address plus reviewed Cloudflare IPv4/IPv6 CIDRs |

`PUBLIC_ORIGIN` is derived as `https://${COLLECTOR_HOSTNAME}`; only override it
when maintaining matching Host labels directly. Non-secret infrastructure
settings can live in your deployment's Compose environment; a password/token
`.env` is never required. First publication uses GitHub's built-in workflow
token; [public package setup](releases.md) removes registry login from deployment.

Compose supplies internal database host/user/name and password-file paths.
Operators do not supply passwords, admin keys or session tokens as environment
variables. On first application initialization, `dc logs app` contains
`OSRS_JOKES_ADMIN_KEY=...`. Use it at `/admin` without a username. Restarts keep
the key without reprinting it. See [admin access](admin.md) for recovery and
rotation commands.

- `postgres_data` stores PostgreSQL under `/var/lib/postgresql/18/docker`.
- `collector_secrets` stores `postgres-password`, a generated 256-bit random
  value encoded as 64 hexadecimal characters. The directory is mode 0700 and
  the file is mode 0600, owned by app UID/GID 1000.
- Docker prefixes volume names with the Compose project name.
- Bootstrap alone mounts secrets writable. It runs as root with only the
  capabilities needed to set file ownership/permissions and inspect PostgreSQL
  data read-only, with networking disabled and a read-only container filesystem.
- App runs as non-root `node` (UID 1000), with a read-only filesystem, read-only
  secret mount and temporary `/tmp`. PostgreSQL also mounts secrets read-only;
  its official entrypoint reads the password as root before dropping privileges.

Bootstrap publishes a fully written, fsynced credential atomically, without
overwriting existing files. Repeated or concurrent starts preserve the password.
Missing/invalid secrets with existing database data stop startup. A well-formed
but incorrect password produces a database authentication error with recovery
instructions; PostgreSQL never changes an existing user's password merely
because `POSTGRES_PASSWORD_FILE` changed.

## Health, logs and lifecycle

```sh
dc ps --all
dc logs bootstrap
dc logs --follow app db
dc stop
dc start
```

App readiness checks `/health/ready` through the image's health check. Compose
starts PostgreSQL only after bootstrap succeeds and the app only after the
database is healthy. The application applies migrations before accepting HTTP.
Database waits and shutdown grace periods are bounded.

Use `dc down` to remove containers/networks while retaining both named volumes.
Use `dc up --detach --wait app` afterward to recreate containers and rerun the
idempotent bootstrap. `dc start` restarts existing containers without rerunning
an exited initializer; use `up` after restoring or repairing credentials.

## Backup

Keep the database dump and matching secret archive together. The dump includes
stable joke/deck IDs and the admin-key/session verifiers.
This procedure pauses application writes and backs up all PostgreSQL objects:

```sh
umask 077
collector_backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$collector_backup_dir"
dc stop app
dc exec -T db pg_dump -U collector -d collector --format=custom > "$collector_backup_dir/database.dump"
dc run --rm --no-deps -T --entrypoint tar bootstrap -C /run/collector-secrets -cf - . > "$collector_backup_dir/secrets.tar"
dc config --images > "$collector_backup_dir/images.txt"
dc start app
```

`backups/` is ignored by Git and excluded from the Docker build context. Keep
these archives in your backup storage with access restricted to the operator.
The generated database password is never printed. The admin key appears only in
its first-start or explicit operator-rotation stdout message.

## Restore and credential recovery

Restore into fresh volumes under a new project name, using the recorded image
versions. Keep the chosen `dc` helper and set `collector_backup_dir` to the
backup directory. For a local rehearsal, set `COLLECTOR_PORT=3001` to avoid a
running instance's localhost port:

```sh
export COMPOSE_PROJECT_NAME=osrs-jokes-restored
export COLLECTOR_PORT=3001
dc run --rm --no-deps -T --entrypoint tar bootstrap -C /run/collector-secrets -xf - < "$collector_backup_dir/secrets.tar"
dc up --detach --wait db
dc exec -T db pg_restore -U collector -d collector --clean --if-exists --no-owner --exit-on-error < "$collector_backup_dir/database.dump"
dc up --detach --wait app
```

For a production cutover, stop the original app before bringing the restored
app onto the same Traefik hostname. Verify readiness and saved deck IDs before
switching traffic, and verify `/admin` accepts the original admin key. Restoring
the verifier does not print or generate a replacement key.

If only credentials are lost/corrupt, stop the stack and restore `secrets.tar`
to its existing `collector_secrets` volume with the same tar command, then run
`dc up --detach --wait app`. The secret archive must match the existing database.
Do not delete volumes or invent a replacement password to resolve this error.

## Upgrade and rollback

1. Create a matching database/secret backup and record the current image digest.
2. Set `COLLECTOR_IMAGE` to the desired release digest and run `dc pull`.
3. Run `dc up --detach --wait app`, then check readiness, logs and the
   [public proxy flow](proxy.md#live-verification). Purge CSS/JS caches or wait
   their five-minute lifetime when upgrading unversioned assets.
4. If the upgrade fails, stop the app and inspect its startup message. An
   authentication failure requires the matching secrets; a changed/unknown
   migration history requires the matching application release.
5. For rollback after schema changes, restore the pre-upgrade database/secret
   backup into fresh volumes and use its recorded image version. The migration
   runner intentionally rejects an older app against unknown newer migrations.

Keep PostgreSQL on the pinned major version. Major PostgreSQL upgrades require
a separate dump/restore migration; changing the image tag alone does not migrate
the existing data directory.

## Local verification

```sh
node --test --test-isolation=none test/bootstrap.test.ts
pnpm test:compose
```

The Docker check builds one uniquely tagged local image, creates an isolated
project, and checks non-root app ownership, file permissions/read-only mounts,
private database networking, restart/recreation, missing/corrupt/mismatched
credentials, a real PostgreSQL dump/restore preserving deck/joke IDs and admin
login, first-start key output, session persistence and operator key rotation.
It deletes only its own test project/volumes/image. No development images are
published and no validation runs in GitHub Actions. The owner runs the complete
`pnpm test` suite manually.

It now also runs the full HTTP curation/export/deletion golden path and checks
the same collection export after recreation and restore. Set
`COLLECTOR_CHECK_IMAGE` to a published version/digest to pull/test that exact
runtime image instead of building, as described in [acceptance.md](acceptance.md).

References: [Compose startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/),
[official PostgreSQL image](https://hub.docker.com/_/postgres),
[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).
