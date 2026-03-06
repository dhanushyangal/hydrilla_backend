-- ============================================================
-- Hydrilla - Subscription & Credits Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- ============================================================
-- 1. USER_SUBSCRIPTIONS
--    Tracks Dodo subscription lifecycle per user
-- ============================================================
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT        REFERENCES users(id),
  email                 TEXT        NOT NULL,
  customer_name         TEXT,
  plan                  TEXT        NOT NULL CHECK (plan IN ('creator', 'studio', 'unknown')),
  status                TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'active', 'on_hold', 'cancelled', 'expired', 'failed')),
  dodo_subscription_id  TEXT        UNIQUE NOT NULL,
  dodo_customer_id      TEXT,
  product_id            TEXT,
  quantity              INTEGER     DEFAULT 1,
  recurring_amount      INTEGER,    -- in smallest currency unit (paise)
  currency              TEXT        DEFAULT 'INR',
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  metadata              JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id
  ON user_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_email
  ON user_subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status
  ON user_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_dodo_id
  ON user_subscriptions (dodo_subscription_id);

-- ============================================================
-- 2. USER_CREDITS
--    Tracks credit balance per user (refreshes each billing cycle)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_credits (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT        REFERENCES users(id),
  email            TEXT        NOT NULL,
  plan             TEXT,       -- 'creator' | 'studio' | null (free tier)
  credits_total    INTEGER     NOT NULL DEFAULT 0,  -- credits granted for this cycle
  credits_used     INTEGER     NOT NULL DEFAULT 0,  -- credits consumed this cycle
  subscription_id  TEXT        REFERENCES user_subscriptions(dodo_subscription_id),
  reset_at         TIMESTAMPTZ,                     -- when credits next reset (period end)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One credits row per user
  CONSTRAINT user_credits_user_id_unique UNIQUE (user_id),
  CONSTRAINT user_credits_email_unique   UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_user_credits_user_id
  ON user_credits (user_id);
CREATE INDEX IF NOT EXISTS idx_user_credits_email
  ON user_credits (email);

-- ============================================================
-- 3. SUBSCRIPTION_PAYMENTS
--    Payment history for all subscription charges
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_payments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT,
  email                 TEXT,
  dodo_payment_id       TEXT        UNIQUE NOT NULL,
  dodo_subscription_id  TEXT,
  amount_cents          INTEGER,
  currency              TEXT        DEFAULT 'INR',
  status                TEXT        NOT NULL CHECK (status IN ('succeeded', 'failed', 'refunded')),
  plan                  TEXT,
  webhook_id            TEXT,
  metadata              JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_id
  ON subscription_payments (user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_email
  ON subscription_payments (email);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription_id
  ON subscription_payments (dodo_subscription_id);

-- ============================================================
-- 4. WEBHOOK_EVENTS
--    Deduplication table - prevents double-processing webhooks
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   TEXT        UNIQUE NOT NULL,
  event_type   TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook_id
  ON webhook_events (webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events (event_type);

-- ============================================================
-- 5. PAYMENT_ATTEMPTS (updated - add plan column if missing)
--    Already referenced in payments.ts, add plan column
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_attempts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT,
  user_id              TEXT,
  checkout_session_id  TEXT,
  payment_id           TEXT,
  refund_id            TEXT,
  plan                 TEXT,       -- 'creator' | 'studio'
  status               TEXT,
  amount_cents         INTEGER,
  currency             TEXT,
  error_message        TEXT,
  webhook_id           TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_email
  ON payment_attempts (email);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_user_id
  ON payment_attempts (user_id);

-- ============================================================
-- 6. TRIGGERS - auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_subscriptions_updated_at ON user_subscriptions;
CREATE TRIGGER update_user_subscriptions_updated_at
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_credits_updated_at ON user_credits;
CREATE TRIGGER update_user_credits_updated_at
  BEFORE UPDATE ON user_credits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_payment_attempts_updated_at ON payment_attempts;
CREATE TRIGGER update_payment_attempts_updated_at
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE user_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credits         ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts     ENABLE ROW LEVEL SECURITY;

-- Service role (backend) bypasses RLS for all tables
CREATE POLICY "service_role_all_user_subscriptions"
  ON user_subscriptions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_user_credits"
  ON user_credits FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_subscription_payments"
  ON subscription_payments FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_webhook_events"
  ON webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_payment_attempts"
  ON payment_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Users can read their own subscription data
CREATE POLICY "users_read_own_subscriptions"
  ON user_subscriptions FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "users_read_own_credits"
  ON user_credits FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "users_read_own_payments"
  ON subscription_payments FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ============================================================
-- Done! Tables created:
--   user_subscriptions  - subscription lifecycle
--   user_credits        - credit balance per user
--   subscription_payments - payment history
--   webhook_events      - deduplication
--   payment_attempts    - checkout attempt log
-- ============================================================
