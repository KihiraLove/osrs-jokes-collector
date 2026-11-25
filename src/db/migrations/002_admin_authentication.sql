-- Sessions were only schema placeholders before authentication was implemented.
DELETE FROM admin_sessions;
ALTER TABLE admin_sessions ADD COLUMN authenticated boolean NOT NULL DEFAULT false;

-- Short-lived counters store hashes of addresses, never raw visitor addresses.
CREATE TABLE admin_rate_limits (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  attempts integer NOT NULL CHECK (attempts > 0),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_rate_limits_window_idx ON admin_rate_limits (window_started_at);
