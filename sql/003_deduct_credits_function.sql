-- Atomic credit deduction: period remaining first, then credits_bonus.
-- Prevents race conditions under high concurrency (FOR UPDATE).
-- Run in Supabase SQL Editor. Prefer 025_credits_bonus_and_breaches.sql for full upgrade.
-- DROP required when changing return type from the older (remaining, success) shape.

DROP FUNCTION IF EXISTS deduct_user_credits(uuid, integer);

CREATE OR REPLACE FUNCTION deduct_user_credits(
  p_credits_row_id uuid,
  p_amount integer
)
RETURNS TABLE(
  remaining integer,
  success boolean,
  period_used_after integer,
  bonus_after integer,
  period_taken integer,
  bonus_taken integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total integer;
  v_used integer;
  v_bonus integer;
  v_period_rem integer;
  v_period_take integer;
  v_bonus_take integer;
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

  v_period_rem := GREATEST(0, v_total - v_used);
  IF (v_period_rem + v_bonus) < p_amount THEN
    RETURN QUERY SELECT (v_period_rem + v_bonus)::integer, false, v_used, v_bonus, 0, 0;
    RETURN;
  END IF;

  v_period_take := LEAST(v_period_rem, p_amount);
  v_bonus_take := p_amount - v_period_take;
  v_new_used := v_used + v_period_take;
  v_new_bonus := v_bonus - v_bonus_take;

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
    v_period_take,
    v_bonus_take;
END;
$$;

COMMENT ON FUNCTION deduct_user_credits(uuid, integer) IS
  'Atomically deduct credits: period remaining first, then credits_bonus. FOR UPDATE locked.';
