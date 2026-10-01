-- Atomic credit refund: prevents race conditions under high concurrency.
-- Companion to 003_deduct_credits_function.sql.
-- Run in Supabase SQL Editor.

CREATE OR REPLACE FUNCTION refund_user_credits(
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

  v_new_used := GREATEST(0, v_used - p_amount);
  UPDATE user_credits
  SET credits_used = v_new_used, updated_at = NOW()
  WHERE id = p_credits_row_id;

  RETURN QUERY SELECT (v_total - v_new_used)::integer, true;
END;
$$;

COMMENT ON FUNCTION refund_user_credits(uuid, integer) IS 'Atomically refunds credits to a user_credits row with FOR UPDATE lock. Returns remaining balance and success.';
