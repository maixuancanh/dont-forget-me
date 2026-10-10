CREATE TABLE IF NOT EXISTS ownership_migrations (
 id text PRIMARY KEY,user_id text NOT NULL,run_id text NOT NULL,personal_account_id text NOT NULL REFERENCES personal_memory_accounts(id),
 preview jsonb NOT NULL,confirmation_hash text NOT NULL,manifest_hash text NOT NULL,expected_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('preview','requested','executing','partial','unknown','unsupported','verified','activated','stale')),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS ownership_migration_records (
 migration_id text NOT NULL REFERENCES ownership_migrations(id),record_id text NOT NULL REFERENCES memory_records(id),
 status text NOT NULL CHECK(status IN ('pending','executing','accepted','verified','unknown')),
 target_receipt jsonb,source_recall jsonb,error_code text,dispatch_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(migration_id,record_id)
);
INSERT INTO schema_migrations(version) VALUES('006_ownership_migration') ON CONFLICT DO NOTHING;
ALTER TABLE ownership_migrations ADD COLUMN IF NOT EXISTS execution_expires_at timestamptz;
ALTER TABLE ownership_migrations ADD COLUMN IF NOT EXISTS execution_token text;
ALTER TABLE ownership_migration_records ADD COLUMN IF NOT EXISTS execution_token text;
