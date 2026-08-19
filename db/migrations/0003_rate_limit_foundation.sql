CREATE TABLE website_rate_limit_buckets (
  game_profile text NOT NULL CHECK (game_profile IN ('wos', 'kingshot')),
  policy_code text NOT NULL CHECK (btrim(policy_code) <> ''),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (
    game_profile,
    policy_code,
    subject_hash,
    window_started_at
  ),
  CHECK (expires_at > window_started_at)
);

CREATE INDEX website_rate_limit_buckets_expiry
  ON website_rate_limit_buckets (expires_at);

ALTER TABLE website_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_rate_limit_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY website_rate_limit_buckets_profile_policy
  ON website_rate_limit_buckets
  USING (game_profile = nullif(current_setting('app.game_profile', true), ''))
  WITH CHECK (game_profile = nullif(current_setting('app.game_profile', true), ''));
