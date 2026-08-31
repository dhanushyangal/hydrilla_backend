-- Shared Water API keys (admin). One row per provider.
-- Safe / additive. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS platform_api_keys (
  provider TEXT PRIMARY KEY
    CHECK (provider IN ('anthropic', 'openai', 'gemini', 'openrouter', 'cursor')),
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  last4 TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (status IN ('unchecked', 'valid', 'invalid')),
  last_error TEXT,
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on platform_api_keys" ON platform_api_keys;
END
$$;

CREATE POLICY "Service role can do everything on platform_api_keys"
  ON platform_api_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);
