-- Migration 020: current paid plan names are starter and pro.
-- Non-destructive: no tables dropped, no rows deleted.
-- Legacy creator/studio values stay allowed, then existing rows are renamed in place.

ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_plan_check;

ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_plan_check
  CHECK (plan = ANY (ARRAY[
    'starter'::text,
    'pro'::text,
    'creator'::text,
    'studio'::text,
    'unknown'::text
  ]));

UPDATE user_subscriptions SET plan = 'starter', updated_at = NOW() WHERE plan = 'creator';
UPDATE user_subscriptions SET plan = 'pro', updated_at = NOW() WHERE plan = 'studio';

UPDATE user_credits SET plan = 'starter', updated_at = NOW() WHERE plan = 'creator';
UPDATE user_credits SET plan = 'pro', updated_at = NOW() WHERE plan = 'studio';

UPDATE subscription_payments SET plan = 'starter' WHERE plan = 'creator';
UPDATE subscription_payments SET plan = 'pro' WHERE plan = 'studio';
