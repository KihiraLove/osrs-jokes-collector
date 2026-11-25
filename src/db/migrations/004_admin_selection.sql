CREATE TABLE admin_joke_selection (
  session_hash bytea NOT NULL REFERENCES admin_sessions(token_hash) ON DELETE CASCADE,
  -- Keep deleted joke IDs until the admin explicitly reconciles the selection.
  -- Cascading them away could silently turn a bulk action into a partial action.
  joke_id uuid NOT NULL,
  PRIMARY KEY (session_hash, joke_id)
);
