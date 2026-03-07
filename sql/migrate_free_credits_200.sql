-- ============================================================
-- Migration: Give all existing users 200 free credits
-- Run this ONCE in Supabase SQL editor.
-- Safe to re-run (INSERT … ON CONFLICT DO NOTHING).
-- ============================================================

-- Insert a free-tier credits row for every user that doesn't already have one
INSERT INTO user_credits (user_id, email, plan, credits_total, credits_used)
SELECT
  u.id        AS user_id,
  u.email     AS email,
  NULL        AS plan,
  200         AS credits_total,
  0           AS credits_used
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_credits uc
  WHERE uc.user_id = u.id
     OR uc.email   = u.email
)
ON CONFLICT DO NOTHING;

-- Verify result
SELECT
  COUNT(*)                                             AS total_credit_rows,
  SUM(CASE WHEN plan IS NULL THEN 1 ELSE 0 END)       AS free_tier_rows,
  SUM(CASE WHEN plan IS NOT NULL THEN 1 ELSE 0 END)   AS paid_rows
FROM user_credits;
