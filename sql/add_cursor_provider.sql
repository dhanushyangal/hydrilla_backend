-- Allow Cursor as a BYOK provider (run once in Supabase SQL Editor).

ALTER TABLE user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'gemini', 'openrouter', 'cursor'));
