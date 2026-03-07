-- Optional one-time backfill: set user_credits.user_id from users table
-- where email matches and user_credits.user_id is currently NULL.
-- Run in Supabase SQL Editor (Production) so existing credit rows are
-- findable by the backend when it looks up by user_id.
UPDATE user_credits uc
SET user_id = u.id, updated_at = NOW()
FROM users u
WHERE uc.email = u.email
  AND uc.user_id IS NULL
  AND u.id IS NOT NULL;
