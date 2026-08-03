-- Add Cursor as a BYOK provider on user_api_keys.
-- Run in Supabase SQL Editor after the base Water/BYOK migration.

ALTER TABLE user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'gemini', 'openrouter', 'cursor'));
