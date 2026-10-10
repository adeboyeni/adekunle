CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  phone text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  pin_hash text,
  pin_attempts int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance_kobo bigint NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per purchase or funding attempt. Amounts are integer kobo.
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('airtime','data','tv','electricity','funding')),
  beneficiary text,
  amount_kobo bigint NOT NULL,        -- what the customer pays / is credited
  cost_kobo bigint,                   -- what the provider charged you
  status text NOT NULL CHECK (status IN ('pending','processing','completed','failed')),
  idempotency_key text NOT NULL,      -- client key (purchases) or Paystack reference (funding)
  provider_reference text,
  message text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS tx_status_idx ON transactions (status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS tx_funding_ref_idx ON transactions (idempotency_key) WHERE type = 'funding';

-- Every balance movement, for audits and dispute handling.
CREATE TABLE IF NOT EXISTS ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  transaction_id uuid REFERENCES transactions(id),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  reason text NOT NULL,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  balance_after_kobo bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger (user_id, created_at DESC);
