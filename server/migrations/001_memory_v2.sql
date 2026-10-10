-- Relational authority. dfm_state is legacy import input only, never a production adapter.
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL, display_name text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(issuer,subject)
);
CREATE TABLE IF NOT EXISTS runs (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), story_version text NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), event_sequence integer NOT NULL DEFAULT 0 CHECK(event_sequence>=0),
 checkpoint jsonb NOT NULL, state jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS domain_events (
 run_id text NOT NULL REFERENCES runs(id), event_id text NOT NULL, user_id text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), kind text NOT NULL, client_action_id text,
 payload jsonb NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,event_id), UNIQUE(run_id,sequence), UNIQUE(run_id,client_action_id),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS account_bindings (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), network text NOT NULL CHECK(network IN ('local','mainnet')),
 mode text NOT NULL CHECK(mode IN ('local','sponsored','personal')), account_id text NOT NULL,
 status text NOT NULL DEFAULT 'active', payload jsonb NOT NULL DEFAULT '{}', UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS memory_records (
 id text PRIMARY KEY, run_id text NOT NULL, user_id text NOT NULL, event_id text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>=0), kind text NOT NULL, payload jsonb NOT NULL,
 payload_bytes text NOT NULL, content_hash text NOT NULL, representation_key text NOT NULL UNIQUE,
 legacy_provenance jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,id), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id),
 FOREIGN KEY(run_id,event_id) REFERENCES domain_events(run_id,event_id)
);
CREATE TABLE IF NOT EXISTS memory_receipts (
 record_id text NOT NULL REFERENCES memory_records(id), account_binding_id text NOT NULL REFERENCES account_bindings(id),
 namespace text NOT NULL, state text NOT NULL CHECK(state IN ('queued','accepted','uploaded','indexed','retrievable','retryable_failure','permanent_failure')),
 content_hash text NOT NULL, receipt jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(record_id,account_binding_id,namespace)
);
CREATE TABLE IF NOT EXISTS outbox_jobs (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, record_id text NOT NULL,
 event_id text NOT NULL, account_binding_id text NOT NULL, namespace text NOT NULL,
 representation_key text NOT NULL UNIQUE, payload_bytes text NOT NULL, content_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','accepted','uploaded','indexed','retrievable','retryable_failure','permanent_failure')),
 accepted_job_id text, receipt jsonb, attempts integer NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT now(),
 lease_token text, lease_expires_at timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(record_id,account_binding_id,namespace), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id),
 FOREIGN KEY(run_id,record_id) REFERENCES memory_records(run_id,id), FOREIGN KEY(account_binding_id,user_id) REFERENCES account_bindings(id,user_id),
 FOREIGN KEY(run_id,event_id) REFERENCES domain_events(run_id,event_id)
);
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox_jobs(retry_at,lease_expires_at) WHERE state IN ('queued','accepted','uploaded','retryable_failure');
CREATE TABLE IF NOT EXISTS turns (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, client_turn_id text NOT NULL,
 expected_revision integer NOT NULL, committed_revision integer NOT NULL, request_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('committed','acknowledged')), response jsonb NOT NULL,
 event_id text NOT NULL, acknowledged_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,id), UNIQUE(run_id,client_turn_id), FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id),
 FOREIGN KEY(run_id,event_id) REFERENCES domain_events(run_id,event_id)
);
CREATE TABLE IF NOT EXISTS actor_projections (
 run_id text NOT NULL REFERENCES runs(id), npc_id text NOT NULL, revision integer NOT NULL DEFAULT 0,
 payload jsonb NOT NULL, PRIMARY KEY(run_id,npc_id)
);
CREATE TABLE IF NOT EXISTS transactions (
 id text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, order_id text NOT NULL,
 item_id text NOT NULL, quantity integer NOT NULL CHECK(quantity>0), price_table_version text NOT NULL,
 unit_price integer NOT NULL CHECK(unit_price>=0), paid_amount integer NOT NULL DEFAULT 0 CHECK(paid_amount>=0),
 accepted_change integer NOT NULL DEFAULT 0 CHECK(accepted_change>=0), state text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}', UNIQUE(run_id,id), UNIQUE(run_id,order_id,item_id),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS action_tokens (
 token_hash text PRIMARY KEY, user_id text NOT NULL, run_id text NOT NULL, revision integer NOT NULL,
 kind text NOT NULL, payload jsonb NOT NULL, consumed_event_id text, expires_at timestamptz NOT NULL,
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS evidence_edges (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), source_id text NOT NULL, target_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('supports','contradicts','derived_from','disclosed_to','supersedes')),
 cause_event_id text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', CHECK(source_id<>target_id),
 FOREIGN KEY(run_id,source_id) REFERENCES memory_records(run_id,id),
 FOREIGN KEY(run_id,target_id) REFERENCES memory_records(run_id,id),
 FOREIGN KEY(run_id,cause_event_id) REFERENCES domain_events(run_id,event_id)
);
CREATE TABLE IF NOT EXISTS lifecycle_jobs (
 id text PRIMARY KEY, run_id text NOT NULL, user_id text NOT NULL, kind text NOT NULL,
 state text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,user_id) REFERENCES runs(id,user_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, user_id text REFERENCES users(id), run_id text REFERENCES runs(id),
 kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_imports (
 source_hash text PRIMARY KEY, source_body jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 limitations jsonb NOT NULL
);
-- Receipt callbacks cannot bind a record to another authenticated owner's account.
CREATE OR REPLACE FUNCTION dfm_receipt_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM memory_records r JOIN account_bindings b ON b.user_id=r.user_id
                WHERE r.id=NEW.record_id AND b.id=NEW.account_binding_id) THEN
  RAISE EXCEPTION 'RECEIPT_SCOPE_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS receipt_owner_guard ON memory_receipts;
CREATE TRIGGER receipt_owner_guard BEFORE INSERT OR UPDATE ON memory_receipts
 FOR EACH ROW EXECUTE FUNCTION dfm_receipt_owner_guard();
INSERT INTO schema_migrations(version) VALUES('001_memory_v2') ON CONFLICT DO NOTHING;
