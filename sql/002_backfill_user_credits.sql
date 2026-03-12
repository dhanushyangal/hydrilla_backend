-- Backfill user_credits: create a row for every user in "users" who does not have one.
-- New and existing users get 200 free-tier credits.
-- Run in Supabase SQL Editor (run once, or periodically to catch new users).

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
WHERE NOT EXISTS (
  SELECT 1 FROM user_credits c
  WHERE c.user_id = u.id
     OR (c.user_id IS NULL AND c.email = u.email)
)
  AND u.email IS NOT NULL
ON CONFLICT DO NOTHING;

-- If your user_credits table has a unique constraint on (user_id) or (email),
-- use the appropriate conflict target. If there is no unique constraint, the above
-- WHERE NOT EXISTS is the only guard. If you have UNIQUE(email), then:
-- ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = NOW()
-- (only if you want to backfill user_id on existing rows).
