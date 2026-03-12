-- Atomic credit deduction: prevents race conditions under high concurrency.
-- Run in Supabase SQL Editor.

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
