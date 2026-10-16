-- Atomic credit refund: restore credits_used first, excess to credits_bonus.
-- Companion to 003_deduct_credits_function.sql / 025_credits_bonus_and_breaches.sql.
-- DROP required when changing return type from the older (remaining, success) shape.

DROP FUNCTION IF EXISTS refund_user_credits(uuid, integer);

CREATE OR REPLACE FUNCTION refund_user_credits(
  p_credits_row_id uuid,
  p_amount integer
)
RETURNS TABLE(
  remaining integer,
  success boolean,
  period_used_after integer,
  bonus_after integer,
  period_restored integer,
  bonus_restored integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total integer;
  v_used integer;
  v_bonus integer;
  v_period_restore integer;
  v_bonus_restore integer;
  v_new_used integer;
  v_new_bonus integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT 0::integer, false, 0::integer, 0::integer, 0::integer, 0::integer;
    RETURN;
  END IF;

  SELECT credits_total, credits_used, COALESCE(credits_bonus, 0)
  INTO v_total, v_used, v_bonus
  FROM user_credits
  WHERE id = p_credits_row_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::integer, false, 0::integer, 0::integer, 0::integer, 0::integer;
    RETURN;
  END IF;

  v_period_restore := LEAST(v_used, p_amount);
  v_bonus_restore := p_amount - v_period_restore;
  v_new_used := v_used - v_period_restore;
  v_new_bonus := v_bonus + v_bonus_restore;

  UPDATE user_credits
  SET
    credits_used = v_new_used,
    credits_bonus = v_new_bonus,
    updated_at = NOW()
  WHERE id = p_credits_row_id;

  RETURN QUERY SELECT
    (GREATEST(0, v_total - v_new_used) + v_new_bonus)::integer,
    true,
    v_new_used,
    v_new_bonus,
    v_period_restore,
    v_bonus_restore;
END;
$$;

COMMENT ON FUNCTION refund_user_credits(uuid, integer) IS
  'Atomically refunds credits: restore credits_used first, excess to credits_bonus.';
