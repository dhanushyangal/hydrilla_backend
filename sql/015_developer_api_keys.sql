-- Migration 015: Developer API Keys for public Hydrilla AI API access
-- Safe / additive. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS developer_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_developer_api_keys_hash ON developer_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_developer_api_keys_user ON developer_api_keys(user_id);

ALTER TABLE developer_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can manage developer_api_keys" ON developer_api_keys;
END
$$;

CREATE POLICY "Service role can manage developer_api_keys"
  ON developer_api_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);
