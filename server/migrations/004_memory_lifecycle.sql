CREATE TABLE IF NOT EXISTS memory_lifecycle_operations (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('delete','renew')),
 preview jsonb NOT NULL, confirmation_hash text NOT NULL, status text NOT NULL CHECK(status IN ('preview','requested','executing','confirmed','unknown','unsupported')),
 dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 1), result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS memory_tombstones (
 user_id text NOT NULL, run_id text NOT NULL, record_id text NOT NULL, operation_id text NOT NULL REFERENCES memory_lifecycle_operations(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,record_id), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id), FOREIGN KEY(run_id,record_id) REFERENCES memory_records(run_id,id)
);
INSERT INTO schema_migrations(version) VALUES('004_memory_lifecycle') ON CONFLICT DO NOTHING;
