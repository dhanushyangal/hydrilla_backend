-- ============================================
-- Early Access Payments Table
-- ============================================
CREATE TABLE IF NOT EXISTS early_access_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  payment_id TEXT UNIQUE,  -- Dodo Payment transaction ID
  payment_status VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending, completed, failed, refunded
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  dodo_payment_link TEXT,  -- Payment link from Dodo
  metadata JSONB,  -- Store additional payment data
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_early_access_payments_user_id ON early_access_payments (user_id);
CREATE INDEX IF NOT EXISTS idx_early_access_payments_payment_id ON early_access_payments (payment_id);
CREATE INDEX IF NOT EXISTS idx_early_access_payments_email ON early_access_payments (email);
CREATE INDEX IF NOT EXISTS idx_early_access_payments_status ON early_access_payments (payment_status);
CREATE INDEX IF NOT EXISTS idx_early_access_payments_created_at ON early_access_payments (created_at DESC);

-- Trigger to update updated_at
DROP TRIGGER IF EXISTS update_early_access_payments_updated_at ON early_access_payments;
CREATE TRIGGER update_early_access_payments_updated_at
  BEFORE UPDATE ON early_access_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS Policies
ALTER TABLE early_access_payments ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role can do everything on early_access_payments"
  ON early_access_payments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Users can read their own payments
CREATE POLICY "Users can read their own payments"
  ON early_access_payments
  FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');
