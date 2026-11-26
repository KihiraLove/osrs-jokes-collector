# Plugin compatibility verification

Collector issue [#9](https://github.com/KihiraLove/osrs-jokes-collector/issues/9)
checks the actual Java importer with unchanged collector downloads. Automated
checks and the owner's in-game result are recorded separately below.

## Reproduce the export fixtures

With the collector's Node/pnpm development dependencies installed:

```sh
pnpm fixtures:check
```

This starts temporary PostgreSQL (or uses `TEST_DATABASE_URL`), creates its own
random schema, seeds fixed example deck/joke IDs and timestamps, logs in, and
calls the real `POST /admin/export` handler. For the renamed fixture it first
posts to the real deck-rename handler. It compares raw attachment bytes to the
committed files, without parsing/re-serializing or converting the JSON. Generated
credentials remain in memory; the schema/connections and temporary PostgreSQL
process are cleaned up. A supplied test database is left running.

To deliberately regenerate the contract fixtures after reviewing a format
change, run `pnpm fixtures:write`. Copy these three files unchanged to
`src/test/resources/collector/` in a checkout of `osrs-jokes`:

- `docs/examples/one-deck.json`
- `docs/examples/decks.json`
- `docs/examples/renamed-decks.json`

Run `sha256sum` on both sets and compare the bytes with `cmp`, then run the
plugin's focused tests from its root:

```sh
./gradlew test --tests com.osrsjokes.CollectorImportTest --tests com.osrsjokes.DeckCodecTest --tests com.osrsjokes.DeckStorageTest --tests com.osrsjokes.JokeDeckTest --tests com.osrsjokes.JokeSettingsPanelTest
```

The collector's focused HTTP regression is
`node --test --test-isolation=none test/export.test.ts`. The owner runs both
complete suites manually. No GitHub validation or development images are used.

## Verified source and fixture identities

The exporter implementation is from collector revision
[`f72a5d50a54384cd8a569d0f23cfaf25afd3b890`](https://github.com/KihiraLove/osrs-jokes-collector/commit/f72a5d50a54384cd8a569d0f23cfaf25afd3b890).
The importer implementation is from plugin revision
[`8bcce9948d80a03f26c2a6773ea43dc141d2bd35`](https://github.com/KihiraLove/osrs-jokes/commit/8bcce9948d80a03f26c2a6773ea43dc141d2bd35).
Neither production implementation changes in this compatibility work; the new
regressions exercise them together. The renamed export uses the same deck UUID
after changing its name to `A renamed deck`, which also changes its position.

| Fixture | SHA-256 |
| --- | --- |
| `one-deck.json` | `1b8a7cd4a1f19b22edc07527964655610580dbd493c1135d98bf029621103994` |
| `decks.json` | `f2075b39a75824b919152d1eb122228780cada635c64751e1f0c5922717e3655` |
| `renamed-decks.json` | `7299775506d677be4b22047be7093606ae399ec338d8fd54bdc8ae5f38b1178d` |

Automated result on 2026-11-26: **passed** — nine collector export tests,
`fixtures:check`, and 17 focused plugin tests (CollectorImportTest,
DeckCodecTest, DeckStorageTest, JokeDeckTest and JokeSettingsPanelTest).
Collector type-checking and generator syntax checks passed. The plugin build
used a temporary Eclipse Temurin JDK 21 with the project's `--release 11`;
the generated test class has Java 11 bytecode (major version 55).

The tests check exact IDs,
names, ordering, quote/backslash/Unicode/comment-like text, CRLF/tabs/blank
lines, the two-part separator, empty decks, draw order/wraparound, and selection
by stable ID after a rename/reorder. Existing codec and storage regressions
cover hand-written files, invalid input and preservation of existing file bytes.
This does not verify in-game rendering or the full asynchronous reload lifecycle.

## Manual in-game verification

**Owner result: pending.** Record the tested revisions/date and the results of
these steps here or in issue #9 after testing. A successful JVM startup or
passing Java test is not an in-game result. Agents must not automate RuneScape
input.

1. Start the development client with `./gradlew run` from `osrs-jokes`. Follow
   RuneLite's [Using Jagex Accounts](https://github.com/runelite/runelite/wiki/Using-Jagex-Accounts)
   instructions to sign in.
2. From the collector's **Export** page, download a populated deck containing
   both joke types plus an empty deck. Back up the current
   `.runelite/osrs-jokes/decks.json`, then replace it with the downloaded file
   unchanged. This replaces the whole local collection.
3. Press **Reload decks** in the card sidebar. Confirm the exported deck names
   appear in **Current deck**. Switch between the decks and draw the jokes in
   order through wraparound. Check single-part text, setup/blank line/punchline,
   embedded line breaks and long-text wrapping/pages. The empty deck should
   draw the normal “No jokes yet” card.
4. Leave the populated deck selected, rename it in the collector, export again,
   replace the file and reload. Confirm the same deck remains selected by ID
   with the new name, even if its position changed. Restart the plugin and
   confirm the selection persists.
5. With a card visible, temporarily make the file invalid and press **Reload
   decks**. Confirm the error is shown and the previous decks/current card
   remain usable. Restore the valid file and reload successfully.

Issue #9 stays open until the owner records this result. The development client
can be launched on request; no account credentials or game actions are automated.
