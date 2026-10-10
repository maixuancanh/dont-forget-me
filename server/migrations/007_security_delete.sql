CREATE TABLE IF NOT EXISTS memory_security_deletions (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, address text NOT NULL,
 preview jsonb NOT NULL, confirmation_hash text NOT NULL, batch_id text NOT NULL,
 tx_bytes text NOT NULL, expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','executing','unknown','confirmed','failed')),
 dispatch_count integer NOT NULL DEFAULT 0, consented_at timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);

