CREATE TABLE submission_rate_limits (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  attempts integer NOT NULL CHECK (attempts > 0),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX submission_rate_limits_window_idx ON submission_rate_limits (window_started_at);
