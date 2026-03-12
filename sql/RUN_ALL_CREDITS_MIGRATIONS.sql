-- Run this entire script in Supabase SQL Editor once to:
-- 1. Add credits_used to jobs
-- 2. Backfill user_credits for every user in "users" who doesn't have a row (200 free credits)
-- 3. Create the atomic deduct_user_credits function for high concurrency
-- Safe to run multiple times (idempotent).

-- =============================================================================
-- 1. Add credits_used column to jobs
-- =============================================================================
ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS credits_used integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN jobs.credits_used IS 'Number of credits consumed for this job (e.g. 10 for 3D, 0 for preview-only)';

-- =============================================================================
-- 2. Backfill user_credits: one row per user in "users" who doesn't have one
--    (200 free credits, 0 used). Uses ON CONFLICT (email) for table with
--    user_credits_email_unique: no duplicate key errors; backfills user_id if missing.
-- =============================================================================
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
ON CONFLICT (email) DO UPDATE SET
  user_id = COALESCE(user_credits.user_id, EXCLUDED.user_id),
  updated_at = NOW();

-- =============================================================================
-- 3. Atomic credit deduction (for high concurrency)
-- =============================================================================
CREATE OR REPLACE FUNCTION deduct_user_credits(
  p_credits_row_id uuid,
  p_amount integer
)
RETURNS TABLE(remaining integer, success boolean)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total integer;
  v_used integer;
  v_new_used integer;
BEGIN
  SELECT credits_total, credits_used
  INTO v_total, v_used
  FROM user_credits
  WHERE id = p_credits_row_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::integer, false;
    RETURN;
  END IF;

  IF (v_total - v_used) < p_amount THEN
    RETURN QUERY SELECT (v_total - v_used)::integer, false;
    RETURN;
  END IF;

  v_new_used := v_used + p_amount;
  UPDATE user_credits
  SET credits_used = v_new_used, updated_at = NOW()
  WHERE id = p_credits_row_id;

  RETURN QUERY SELECT (v_total - v_new_used)::integer, true;
END;
$$;

COMMENT ON FUNCTION deduct_user_credits(uuid, integer) IS 'Atomically deduct credits from a user_credits row. Returns remaining balance and success.';
