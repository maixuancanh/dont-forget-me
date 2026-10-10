CREATE TABLE IF NOT EXISTS memory_operations (
 run_id text NOT NULL, operation_id text NOT NULL, user_id text NOT NULL,
 account_binding_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('analyze','restore')),
 request_hash text NOT NULL, confirmation_hash text NOT NULL, request_bytes text NOT NULL,
 scope jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','dispatched','completed','unknown')),
 dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 1),
 result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,operation_id), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id),
 FOREIGN KEY(account_binding_id,user_id) REFERENCES account_bindings(id,user_id)
);
INSERT INTO schema_migrations(version) VALUES('002_memory_operations') ON CONFLICT DO NOTHING;
