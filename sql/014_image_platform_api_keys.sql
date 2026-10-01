-- Shared Image Generation API keys (OpenAI / Gemini).
-- Separate from Water / Code Sculpt LLM platform keys.
-- Safe / additive. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS image_platform_api_keys (
  provider TEXT PRIMARY KEY
    CHECK (provider IN ('openai', 'gemini')),
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

ALTER TABLE image_platform_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on image_platform_api_keys" ON image_platform_api_keys;
END
$$;

CREATE POLICY "Service role can do everything on image_platform_api_keys"
  ON image_platform_api_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);
