-- user_credits: remove email entirely; use only user_id. No email conflicts.
-- Run in Supabase SQL Editor once. Then run backfill (step 4) anytime to add new users.

-- 1. Drop unique constraint on email (if exists)
DO $$
BEGIN
  ALTER TABLE user_credits DROP CONSTRAINT IF EXISTS user_credits_email_unique;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE user_credits DROP CONSTRAINT IF EXISTS user_credits_email_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- 2. Drop email column
ALTER TABLE user_credits DROP COLUMN IF EXISTS email;

-- 3. Ensure unique on user_id (for ON CONFLICT)
DO $$
BEGIN
  ALTER TABLE user_credits ADD CONSTRAINT user_credits_user_id_unique UNIQUE (user_id);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- 4. Backfill: one row per user in "users" that doesn't have a row (user_id only, no email)
INSERT INTO user_credits (user_id, plan, credits_total, credits_used, created_at, updated_at)
SELECT
  u.id,
  NULL,
  200,
  0,
  NOW(),
  NOW()
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM user_credits c WHERE c.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;
