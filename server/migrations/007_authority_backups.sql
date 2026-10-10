CREATE TABLE IF NOT EXISTS authority_backup_jobs (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL,
 revision integer NOT NULL, binding_id text NOT NULL, principal_hash text NOT NULL,
 scope jsonb NOT NULL, captured jsonb, result jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry','complete')),
 error_code text, lease_token text, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,run_id,revision,binding_id),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
ALTER TABLE authority_backup_jobs ADD COLUMN IF NOT EXISTS upstream_job_id text;
ALTER TABLE authority_backup_jobs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
