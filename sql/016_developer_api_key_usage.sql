-- Migration 016: Track developer API key credit usage and request analytics
-- Safe / additive. Run in Supabase SQL Editor.

-- 1. Add aggregate counters to developer_api_keys
ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS total_credits_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS total_requests INTEGER NOT NULL DEFAULT 0;

-- 2. Create developer_api_key_usage log table
CREATE TABLE IF NOT EXISTS developer_api_key_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES developer_api_keys(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  credits_deducted INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_key_usage_key ON developer_api_key_usage(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_key_usage_user ON developer_api_key_usage(user_id, created_at DESC);

-- 3. Row Level Security
ALTER TABLE developer_api_key_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can manage developer_api_key_usage" ON developer_api_key_usage;
END
$$;

CREATE POLICY "Service role can manage developer_api_key_usage"
  ON developer_api_key_usage FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 4. Atomic function to record usage and update key totals
CREATE OR REPLACE FUNCTION record_developer_key_usage(
  p_api_key_id UUID,
  p_user_id TEXT,
  p_endpoint TEXT,
  p_method TEXT,
  p_status_code INTEGER,
  p_credits_deducted INTEGER DEFAULT 0,
  p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_usage_id UUID;
BEGIN
  INSERT INTO developer_api_key_usage (
    api_key_id,
    user_id,
    endpoint,
    method,
    status_code,
    credits_deducted,
    details
  ) VALUES (
    p_api_key_id,
    p_user_id,
    p_endpoint,
    p_method,
    p_status_code,
    p_credits_deducted,
    p_details
  ) RETURNING id INTO v_usage_id;

  UPDATE developer_api_keys
  SET
    total_credits_used = total_credits_used + GREATEST(COALESCE(p_credits_deducted, 0), 0),
    total_requests = total_requests + 1,
    last_used_at = NOW()
  WHERE id = p_api_key_id;

  RETURN v_usage_id;
END;
$$;
