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

## Browse and moderate jokes

After login, `/admin` opens `/admin/jokes`. Each joke shows its complete text,
separate setup/punchline when applicable, themes, current deck and submission
time in UTC. Filter by **All themes**, any existing theme, **No theme**, and
optionally **Unassigned deck**. Unused themes remain in the filter.

Pages contain up to 25 jokes. **Older jokes** keeps the active filters and uses
the exact PostgreSQL timestamp plus stable joke ID, so new submissions or
deletions do not shift later pages. **Newest page** starts again with the same
filters; applying a new filter starts at its newest page. Multi-theme jokes
appear once per page.

**Edit themes** reuses the public editable picker, complete checkbox list and
normalization rules. Add existing/new themes or remove every selection to leave
a joke unthemed. Saving changes only the associations; the text and deck stay
the same. Validation errors retain the selected values.

**Delete joke** opens a confirmation page showing the full joke. Confirming
removes that joke and its associations, while keeping its deck and themes.
Cancel returns to the filtered listing. GET requests never delete records.

The **Themes** page includes every theme and its joke count. **Delete theme**
shows how many associations will be removed. Confirming preserves all jokes and
deck assignments. If the count has changed since the confirmation page loaded,
the app shows the new count and requires another confirmation. Refreshed public
and admin theme choices reflect the deletion. Deletions are permanent; backups
are described in [deployment.md](deployment.md).

Stale/deleted records, invalid page links, empty results and temporary database
failures have explicit feedback. Successful edits/deletions redirect to a GET
page with a result message, so refresh does not repeat the mutation.

## Decks and bulk assignment

The **Decks** page creates empty decks, shows their joke counts and immutable
export IDs, and provides rename/delete controls. Names are required, allow up
to 100 Unicode code points after normalization, and are case-insensitively
unique. Renaming preserves the export ID. Deck deletion requires confirmation
and unassigns its jokes while preserving their text and themes. A changed joke
count requires a fresh confirmation. Empty decks remain manageable.

On **Jokes**, check individual jokes or use **Select current page**. This selects
only the explicit visible rows. The total count includes selections on other
pages or outside current filters; these hidden selections are called out.
Selecting the same joke under several themes counts it once. **Clear selection**
clears the entire selection. Up to 500 jokes can be selected.

Checkbox changes save automatically before normal page/filter navigation. With
JavaScript disabled, use **Update selection** before changing filters or pages.
Selection lives in PostgreSQL under the current admin session, survives app
restarts, and is shared by tabs using that session. Logout/key rotation removes
it, and expired sessions cannot use it. No browser-storage token is needed.

Choose an existing deck, **Create a new deck**, or **Remove from deck**, then
**Apply to selection**. The entire saved selection is applied in one transaction,
including new-deck creation when requested. A joke has zero or one deck, so
assigning a different deck moves it. Success reports affected/moved counts,
clears the selection and refreshes memberships/counts. Specific decks can also
be selected in the listing's Deck filter or opened with **View jokes**.

If a selected joke or target deck was deleted, the action reports a conflict
without changing any remaining membership. Deleted joke IDs remain selected so
they cannot silently disappear from a bulk action; use **Remove deleted
selections**, then review/retry, or clear the selection. Actions also reject an
outdated selection from another tab. Failed actions retain the saved selection.

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
  Admin pages use `Referrer-Policy: same-origin` so native form posts retain
  origin information; no referrer is sent to another origin.
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
