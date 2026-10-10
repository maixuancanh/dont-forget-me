CREATE TABLE IF NOT EXISTS memory_wallet_renewals (
 id text PRIMARY KEY,user_id text NOT NULL,run_id text NOT NULL,address text NOT NULL,
 preview jsonb NOT NULL,confirmation_hash text NOT NULL,prepared jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','verifying','confirmed','unknown')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
INSERT INTO schema_migrations(version) VALUES('008_wallet_renewals') ON CONFLICT DO NOTHING;
