CREATE TABLE IF NOT EXISTS case_shares (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 run_id text NOT NULL REFERENCES runs(id),
 client_action_id text NOT NULL,
 request_hash text NOT NULL,
 token_hash text NOT NULL UNIQUE,
 snapshot jsonb NOT NULL,
 snapshot_hash text NOT NULL,
 includes_private boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 UNIQUE(user_id, run_id, client_action_id),
 CHECK(expires_at > created_at),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
INSERT INTO schema_migrations(version) VALUES('003_case_shares') ON CONFLICT DO NOTHING;
