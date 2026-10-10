CREATE TABLE IF NOT EXISTS wallet_challenges (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),account_id text NOT NULL,address text NOT NULL,
 message text NOT NULL,expires_at timestamptz NOT NULL,consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS personal_memory_accounts (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),account_id text NOT NULL,address text NOT NULL,
 public_key text NOT NULL,encrypted_secret text NOT NULL,status text NOT NULL DEFAULT 'owner_verified',
 grant_digest text,revoke_digest text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,account_id)
);

CREATE TABLE IF NOT EXISTS delegate_intents (id text PRIMARY KEY,user_id text NOT NULL,account_id text NOT NULL REFERENCES personal_memory_accounts(id),kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,digest text UNIQUE,consumed boolean NOT NULL DEFAULT false);
