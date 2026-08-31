-- Rename gemini → google, then allow only canonical provider ids.

UPDATE user_api_keys SET provider = 'google' WHERE provider = 'gemini';
UPDATE platform_api_keys SET provider = 'google' WHERE provider = 'gemini';

ALTER TABLE user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'google', 'openrouter', 'cursor'));

ALTER TABLE platform_api_keys
  DROP CONSTRAINT IF EXISTS platform_api_keys_provider_check;

ALTER TABLE platform_api_keys
  ADD CONSTRAINT platform_api_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'google', 'openrouter', 'cursor'));
