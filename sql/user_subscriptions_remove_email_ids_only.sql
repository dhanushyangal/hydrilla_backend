-- user_subscriptions: remove email; use only IDs (user_id, dodo_subscription_id) to avoid conflicts.
-- Run in Supabase SQL Editor. Safe to run once.

-- 1. Drop unique constraint on email if it exists (avoids duplicate-key conflicts)
DO $$
BEGIN
  ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_email_unique;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_email_key;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- 2. Drop the email column (table is keyed by dodo_subscription_id / user_id only)
ALTER TABLE user_subscriptions DROP COLUMN IF EXISTS email;
