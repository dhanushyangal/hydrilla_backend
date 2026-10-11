-- Migration 019: Allow current Starter plan on existing subscription rows.
-- Non-destructive: does not drop tables, does not delete or rewrite existing data.
-- Keeps legacy 'creator' values valid so current paid rows continue to work.

ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_plan_check;

ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_plan_check
  CHECK (plan = ANY (ARRAY[
    'starter'::text,
    'creator'::text,
    'studio'::text,
    'unknown'::text
  ]));
