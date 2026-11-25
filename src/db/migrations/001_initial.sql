-- Match the Unicode White_Space property plus BOM used by normalization.ts.
CREATE FUNCTION collector_has_text(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT value ~ U&'[^\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
$$;

CREATE TABLE themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (collector_has_text(name) AND char_length(name) <= 80),
  normalized_name text COLLATE "C" NOT NULL UNIQUE CHECK (collector_has_text(normalized_name))
);

CREATE TABLE decks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (collector_has_text(name) AND char_length(name) <= 100),
  normalized_name text COLLATE "C" NOT NULL UNIQUE CHECK (collector_has_text(normalized_name))
);

CREATE TABLE jokes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('single', 'two_part')),
  text text NOT NULL CHECK (collector_has_text(text) AND char_length(text) <= 4000),
  punchline text CHECK (char_length(punchline) <= 4000),
  deck_id uuid REFERENCES decks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT joke_parts CHECK (
    (kind = 'single' AND punchline IS NULL)
    OR (kind = 'two_part' AND punchline IS NOT NULL AND collector_has_text(punchline))
  )
);

CREATE TABLE joke_themes (
  joke_id uuid NOT NULL REFERENCES jokes(id) ON DELETE CASCADE,
  theme_id uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  PRIMARY KEY (joke_id, theme_id)
);

CREATE INDEX jokes_created_at_id_idx ON jokes (created_at DESC, id DESC);
CREATE INDEX jokes_deck_id_idx ON jokes (deck_id);
CREATE INDEX joke_themes_theme_joke_idx ON joke_themes (theme_id, joke_id);

-- Credential generation, login and session management are implemented in issue #4.
CREATE TABLE admin_credentials (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE admin_sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  credential_id boolean NOT NULL DEFAULT true REFERENCES admin_credentials(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);
