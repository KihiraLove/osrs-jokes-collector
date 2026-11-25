# OSRS Jokes Collector

A small website for collecting jokes and curating decks for the
[OSRS Jokes RuneLite plugin](https://github.com/KihiraLove/osrs-jokes).
The interface uses a simple OSRS brown/yellow palette.

This first implementation covers [issue #2](https://github.com/KihiraLove/osrs-jokes-collector/issues/2):
the server scaffold, PostgreSQL schema, migrations and transactional data access.
The public form, admin login, deck controls, JSON download and production Compose
packaging are tracked separately in the [MVP plan](https://github.com/KihiraLove/osrs-jokes-collector/issues/1).

## Local development

Use Node.js **24.22.3** (also pinned in `.nvmrc`), pnpm **11.25.0**, and a local
PostgreSQL **17 or newer** database. Install pnpm if needed with
`npm install --global pnpm@11.25.0`.

```sh
pnpm install --frozen-lockfile
DATABASE_URL=postgresql://localhost/osrs_jokes_collector pnpm migrate
DATABASE_URL=postgresql://localhost/osrs_jokes_collector pnpm dev
```

Create the database beforehand with your local PostgreSQL tools. The database
role must be able to create tables/functions and run migrations. Connection
credentials belong in your local environment, never in tracked files.
Alternatively, omit `DATABASE_URL` and use the standard node-postgres `PGHOST`,
`PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` settings supported by your local
PostgreSQL installation. No `.env` loader is required.

The app listens on `http://127.0.0.1:3000` by default. Optional `HOST` and `PORT`
override the bind address and port. Automatic production credential generation
and Docker Compose are the next issue; production will not require manually
supplied passwords or tokens.

```sh
pnpm build
DATABASE_URL=postgresql://localhost/osrs_jokes_collector pnpm start
```

Build output goes to ignored `dist/`, including SQL migrations and CSS. The
compiled migration command is `node dist/db/migrate.js`.

## Migrations and lifecycle

Startup applies migrations before listening. `pnpm migrate` applies the same
migrations without starting HTTP. SQL files in `src/db/migrations/` are ordered
by their unique three-digit version prefix. Add a new migration for each schema
change; never edit an already applied file.

Migration SQL and the migration ledger commit in one transaction protected by
a PostgreSQL advisory lock, so concurrent starts cannot apply the same change
twice. SHA-256 checksums detect changed history and an older application refuses
a database with unknown migrations. Startup fails safely on a mismatch.

`GET /health/live` checks the HTTP service. `GET /health/ready` returns 200 only
after initialization and a successful database query; outages return 503 without
connection details. SIGINT/SIGTERM close the HTTP service and connection pool.
Connection/query timeouts bound database waits. Forwarded headers are untrusted
until the production proxy configuration is implemented.

## Data rules

- Jokes store `single` or `two_part`, first text, nullable punchline, timestamp,
  and a nullable deck ID. Single jokes cannot have a punchline; two-part jokes
  require both parts. Database checks reject blank/oversized parts, including
  Unicode whitespace. Each part allows up to 4,000 Unicode code points.
- Themes use a many-to-many join table. A joke may have no themes; submissions
  accept up to ten theme entries. Themes may remain unused.
- Theme names allow 80 code points; deck names allow 100. Names use NFKC Unicode
  normalization, collapse runs of the Unicode `White_Space` property plus BOM
  (`U+FEFF`) to one ASCII space, and trim outer spaces. The unique lookup key is
  the normalized display name converted with JavaScript's locale-independent
  `toLowerCase()`. PostgreSQL compares that stored key using the `C` collation.
  This preserves accents and does not transliterate or apply full case folding
  (for example, `ß` and `ss` stay distinct). Existing theme display names are
  retained when equivalent names are submitted concurrently.
- Joke text trims outer Unicode whitespace plus BOM but preserves meaningful
  internal whitespace, Unicode and line breaks. It is not NFKC-normalized.
- Deck IDs are immutable UUIDs and are suitable as future export IDs. Renaming
  a deck preserves its ID. Every joke belongs to zero or one deck.
- Deleting a theme removes only its associations. Deleting a deck unassigns its
  jokes. Deleting a joke removes its theme links. Other records survive.
- `JokeRepository` uses parameterized queries and transactions for submissions,
  theme replacement and bulk deck moves. Stale bulk selections/targets fail as a
  whole. Creation of a deck with its initial selection is also atomic.
- Joke pagination uses `(created_at, id)` and preserves microseconds in its
  cursor. Theme/deck indexes support filtering and membership queries. Deck
  reads use one snapshot, include empty decks and exclude unassigned jokes.
- The schema reserves admin-key/session verifier storage; authentication is
  implemented in its own issue. No admin credential is generated at this step.

## Local checks

All validation runs locally. Do not add GitHub Actions validation jobs or publish
development images. During implementation, run only the focused checks needed
for the changed behavior, for example:

```sh
pnpm typecheck
pnpm build
node --test --test-isolation=none --test-name-pattern='name normalization' test/normalization.test.ts
node --test --test-isolation=none --test-name-pattern='readiness|migration failure' test/app.test.ts
node --test --test-isolation=none --test-name-pattern='migration startup|database constraints' test/database.test.ts
```

Database tests automatically start a temporary PostgreSQL 18.7 process using the
dev-only `embedded-postgres` dependency. Run `pnpm install --frozen-lockfile`
after updating the branch to install its platform binaries. No Docker daemon,
existing database, or environment variables are required. Run tests as your
normal user, since PostgreSQL cannot run as root. Each run gets a temporary data
directory and random credentials; PostgreSQL stops and its data is deleted
afterward. On Linux/macOS it uses a private Unix socket; on Windows it uses a
free localhost port.

To use an existing database instead, set `TEST_DATABASE_URL` to a dedicated local
test database with a role allowed to create schemas. This overrides automatic
startup. Each run creates and removes only its own random schema; it does not
stop the supplied database or truncate application data. Tests use real
PostgreSQL for migration concurrency, constraints, concurrent themes, deletion
semantics and rollback of stale bulk selections.

**The owner runs the complete suite manually:**

```sh
pnpm test
```

Only release images will be published. GitHub Actions may build/publish an
explicitly triggered release after local validation; it must not run validation
or publish branch, pull-request, development or commit-only images.

## License

[BSD-2-Clause](LICENSE).
