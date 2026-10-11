-- Move each account onto the current monthly allotment.
-- Free 200 -> 100. Starter 1000 -> 900. Pro 4000 -> 3000.
-- Does not change credits_used, and does not touch balances that were never the old plan amount.

UPDATE user_credits
SET credits_total = 900, updated_at = NOW()
WHERE plan = 'starter';

UPDATE user_credits
SET credits_total = 3000, updated_at = NOW()
WHERE plan = 'pro';

UPDATE user_credits
SET credits_total = 100, credits_used = 0, updated_at = NOW()
WHERE plan IS NULL OR plan NOT IN ('starter', 'pro');
