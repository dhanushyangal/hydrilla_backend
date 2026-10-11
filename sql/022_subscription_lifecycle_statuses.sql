-- Allow the subscription states Dodo actually sends.
-- Does not delete rows. Existing on_hold / active / cancelled values stay valid.

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;

ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_status_check
  CHECK (status IN (
    'pending',
    'active',
    'on_hold',
    'past_due',
    'paused',
    'cancelled',
    'expired',
    'failed'
  ));
