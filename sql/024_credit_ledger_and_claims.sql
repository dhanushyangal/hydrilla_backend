-- ============================================================
-- Hydrilla - Credit Ledger & Claim Links (HYD-47)
-- Run this in your Supabase SQL editor
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_claim_links (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token                 TEXT        NOT NULL UNIQUE,
  amount                INTEGER     NOT NULL CHECK (amount > 0),
  reason                TEXT,
  expires_at            TIMESTAMPTZ,
  max_claims            INTEGER     NOT NULL DEFAULT 1 CHECK (max_claims > 0),
  claims_used           INTEGER     NOT NULL DEFAULT 0 CHECK (claims_used >= 0),
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  allowed_email         TEXT,
  created_by_admin_id   TEXT,
  created_by_admin_email TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_claim_links_token
  ON credit_claim_links (token);
CREATE INDEX IF NOT EXISTS idx_credit_claim_links_status
  ON credit_claim_links (status);
CREATE INDEX IF NOT EXISTS idx_credit_claim_links_created_at
  ON credit_claim_links (created_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta                 INTEGER     NOT NULL,
  balance_total_after   INTEGER     NOT NULL,
  balance_used_after    INTEGER     NOT NULL,
  source                TEXT        NOT NULL CHECK (source IN ('admin_grant', 'admin_remove', 'claim_link', 'system')),
  reason                TEXT,
  admin_user_id         TEXT,
  admin_email           TEXT,
  claim_link_id         UUID        REFERENCES credit_claim_links(id) ON DELETE SET NULL,
  metadata              JSONB       DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id
  ON credit_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_created_at
  ON credit_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_claim_link_id
  ON credit_ledger (claim_link_id);

COMMENT ON TABLE credit_claim_links IS 'Sharable links for claiming Hydrilla credits';
COMMENT ON TABLE credit_ledger IS 'Auditable transaction log for credit grants, adjustments, and claims';
