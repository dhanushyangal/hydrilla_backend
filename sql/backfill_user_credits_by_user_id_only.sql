-- Backfill user_credits by user_id only: every user in "users" gets one row (200 free credits).
-- No reliance on email for the insert; uses ON CONFLICT (user_id).
-- Run in Supabase SQL Editor. Safe to run multiple times.

-- 1. Ensure there is a unique constraint on user_id (so we can use ON CONFLICT (user_id)).
--    If you already have UNIQUE(user_id) or user_id as PK, this will no-op (catches duplicate_object).
DO $$
BEGIN
  ALTER TABLE user_credits ADD CONSTRAINT user_credits_user_id_unique UNIQUE (user_id);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN
    NULL;  -- constraint or index already exists
END $$;

-- 2. Backfill user_id on existing user_credits rows where email matches a user but user_id is null.
UPDATE user_credits c
SET user_id = u.id, updated_at = NOW()
FROM users u
WHERE c.email = u.email AND c.user_id IS NULL;

-- 3. Insert one row per user in "users" that has no user_credits row (neither by user_id nor by email).
--    Skips users whose email already exists in user_credits to avoid violating user_credits_email_unique.
INSERT INTO user_credits (user_id, email, plan, credits_total, credits_used, created_at, updated_at)
SELECT
  u.id,
  u.email,
  NULL,
  200,
  0,
  NOW(),
  NOW()
FROM users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM user_credits c WHERE c.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM user_credits c2 WHERE c2.email = u.email)
ON CONFLICT (user_id) DO NOTHING;
