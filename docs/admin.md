# Admin access

Visit `/admin` and enter the admin key. No username is needed. Initial startup
generates a random 256-bit key, commits its SHA-256 verifier to PostgreSQL, and
prints this line to the application container's standard output:

```text
OSRS_JOKES_ADMIN_KEY=...
```

Use `dc logs app` with the Compose helper in [deployment.md](deployment.md).
Existing installations receive their first key on startup of this release.
Concurrent starts initialize one credential; restarts preserve it without
printing it again. The key itself is not stored in a file or PostgreSQL.

## Recover or rotate a key

If the initial log was missed, or a key should be replaced, run:

```sh
dc exec -T app node dist/admin-key.js rotate
```

This operator-only command generates/prints a new key and revokes all admin
sessions, including anonymous login challenges, in one transaction. The old key
stops working. There is no HTTP rotation endpoint or manually configured
admin-key/signing-secret environment variable.

If the app is stopped but the database can start:

```sh
dc up --detach --wait db
dc run --rm --no-deps -T app dist/admin-key.js rotate
```

For development outside Compose, use your normal database settings:

```sh
DATABASE_URL=postgresql://localhost/osrs_jokes_collector pnpm admin:key:rotate
```

## Sessions and request protection

- Authenticated sessions expire after eight hours. The browser holds an opaque
  256-bit token in an HttpOnly, SameSite=Strict cookie; PostgreSQL stores only
  its verifier. Secrets are not saved to localStorage/sessionStorage, placed in
  URLs or returned in JSON.
- HTTPS uses a Secure, host-only `__Host-osrs-jokes-admin` cookie with Path `/`.
  Cookie security does not depend on client-supplied forwarding headers.
- Login uses a 15-minute anonymous session and a CSRF token derived from its
  HttpOnly cookie. Unsafe requests require a valid session, matching CSRF
  field/header, and the configured Origin (or same-origin Referer fallback).
  Successful login replaces the anonymous token. GET/HEAD never log out or
  mutate collection/credential data; login challenges create temporary security
  state only.
- Login permits five attempts per client address per minute, with a global
  limit of 100/minute. Anonymous challenge creation is bounded too. Counters
  are shared in PostgreSQL, expire after a minute, and store address hashes
  instead of raw addresses. A 429 response includes Retry-After.
- Verification uses one-way hashes and constant-time comparisons. Login and
  rotation coordinate locks so an old-key login cannot create an authenticated
  session after rotation revoked sessions.
- Admin responses are private/noncacheable. HTML values are escaped, framing
  is disabled, and credential/cookie/body/query data is excluded from ordinary
  logs. Initial-key and explicit rotation stdout messages are intentional
  exceptions.

## HTTPS, localhost and proxies

Compose derives `PUBLIC_ORIGIN=https://...` from `COLLECTOR_HOSTNAME`; use the
Traefik override with your HTTPS hostname. CSRF validation uses this configured
origin independently of the request's Host and forwarding headers.

`compose.local.yaml` explicitly enables HTTP on
`http://127.0.0.1:${COLLECTOR_PORT:-3000}`. It uses the separate
`osrs-jokes-admin-local` cookie without Secure. Non-loopback HTTP is rejected;
production HTTP requires `ALLOW_INSECURE_LOCAL_ADMIN=true`. Direct `pnpm dev`
defaults to localhost development. Use `127.0.0.1` in the browser to match that
origin; switching to `localhost` changes the Origin header.

`TRUSTED_PROXY_CIDRS` is an optional comma-separated list of explicit trusted
proxy IPs/CIDRs. Forwarding headers are ignored by default. Configure the actual
Traefik/Cloudflare chain before enabling visitor-specific limits through those
proxies; without it, clients share the proxy address's login limit. Boolean
blanket trust and `/0` ranges are rejected. Deployment-specific proxy/Cloudflare
configuration is tracked in issue #10.

## Backup and extension

PostgreSQL backups include credential/session verifiers. Follow the
database-first restore procedure in [deployment.md](deployment.md), then start
the app. The restored key continues to work and is not regenerated or printed.
The opt-in Docker check verifies restored login and live key rotation.

New admin curation/export routes must be registered through the protected scope
in `src/admin/routes.ts` (its `routes` callback is available to feature modules).
Authentication, cache policy and CSRF checks apply automatically. HTML forms
submit a hidden `csrf` field; same-origin JSON requests can use `X-CSRF-Token`
from the page's existing hidden field.

References: [Fastify cookies](https://github.com/fastify/fastify-cookie),
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
