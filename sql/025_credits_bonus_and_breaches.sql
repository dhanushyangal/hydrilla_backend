-- ============================================================
-- Hydrilla - Credits bonus bucket, atomic spend/refund with bonus,
-- atomic claim links, ledger source widen, free reset_at backfill
-- Run in Supabase SQL Editor before deploying backend that depends on it.
-- ============================================================

-- 1) Bonus bucket (survives period renewal)
ALTER TABLE user_credits
  ADD COLUMN IF NOT EXISTS credits_bonus INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN user_credits.credits_bonus IS
  'Promo/admin/claim credits that survive monthly period reset; spent after period allotment';

-- 2) Widen credit_ledger.source for spend / refund / period_reset
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_source_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_source_check
  CHECK (source IN (
    'admin_grant',
    'admin_remove',
    'claim_link',
    'system',
    'spend',
    'refund',
    'period_reset'
  ));

-- 3) Atomic deduct: period first, then bonus. No non-atomic path.
-- Must DROP first: CREATE OR REPLACE cannot change OUT/return row type (42P13).
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

-- 4) Atomic refund: restore period used first, then bonus
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
  'Atomically refund credits: restore credits_used first, excess to credits_bonus.';

-- 5) Atomic claim: reserve claim slot then grant into credits_bonus
CREATE OR REPLACE FUNCTION claim_credit_link(
  p_token text,
  p_user_id text,
  p_user_email text DEFAULT NULL
)
RETURNS TABLE(
  success boolean,
  error_code text,
  amount integer,
  remaining integer,
  total integer,
  used integer,
  bonus integer,
  claim_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_link credit_claim_links%ROWTYPE;
  v_row user_credits%ROWTYPE;
  v_new_bonus integer;
  v_already uuid;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) = 0 OR p_user_id IS NULL OR length(trim(p_user_id)) = 0 THEN
    RETURN QUERY SELECT false, 'invalid_request'::text, 0, 0, 0, 0, 0, NULL::uuid;
    RETURN;
  END IF;

  SELECT *
  INTO v_link
  FROM credit_claim_links
  WHERE token = trim(p_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, 0, 0, 0, 0, 0, NULL::uuid;
    RETURN;
  END IF;

  IF v_link.status = 'disabled' THEN
    RETURN QUERY SELECT false, 'disabled'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
    RETURN;
  END IF;

  IF v_link.expires_at IS NOT NULL AND v_link.expires_at <= NOW() THEN
    RETURN QUERY SELECT false, 'expired'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
    RETURN;
  END IF;

  IF v_link.claims_used >= v_link.max_claims THEN
    RETURN QUERY SELECT false, 'exhausted'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
    RETURN;
  END IF;

  IF v_link.allowed_email IS NOT NULL AND length(trim(v_link.allowed_email)) > 0 THEN
    IF p_user_email IS NULL
       OR lower(trim(p_user_email)) <> lower(trim(v_link.allowed_email)) THEN
      RETURN QUERY SELECT false, 'email_mismatch'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
      RETURN;
    END IF;
  END IF;

  SELECT id INTO v_already
  FROM credit_ledger
  WHERE claim_link_id = v_link.id AND user_id = p_user_id
  LIMIT 1;

  IF v_already IS NOT NULL THEN
    RETURN QUERY SELECT false, 'already_claimed'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
    RETURN;
  END IF;

  -- Reserve the claim slot before mutating balances
  UPDATE credit_claim_links
  SET claims_used = claims_used + 1, updated_at = NOW()
  WHERE id = v_link.id
    AND claims_used < max_claims
    AND status = 'active';

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'exhausted'::text, v_link.amount, 0, 0, 0, 0, v_link.id;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM user_credits WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO user_credits (user_id, plan, credits_total, credits_used, credits_bonus, reset_at)
    VALUES (p_user_id, NULL, 100, 0, v_link.amount, NOW() + INTERVAL '1 month')
    RETURNING * INTO v_row;
    v_new_bonus := v_link.amount;
  ELSE
    v_new_bonus := COALESCE(v_row.credits_bonus, 0) + v_link.amount;
    UPDATE user_credits
    SET credits_bonus = v_new_bonus, updated_at = NOW()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO credit_ledger (
    user_id,
    delta,
    balance_total_after,
    balance_used_after,
    source,
    reason,
    claim_link_id,
    metadata
  ) VALUES (
    p_user_id,
    v_link.amount,
    v_row.credits_total,
    v_row.credits_used,
    'claim_link',
    COALESCE(v_link.reason, 'Credit claim link'),
    v_link.id,
    jsonb_build_object(
      'token', v_link.token,
      'credits_bonus_after', v_new_bonus
    )
  );

  RETURN QUERY SELECT
    true,
    NULL::text,
    v_link.amount,
    (GREATEST(0, v_row.credits_total - v_row.credits_used) + v_new_bonus)::integer,
    v_row.credits_total,
    v_row.credits_used,
    v_new_bonus,
    v_link.id;
END;
$$;

COMMENT ON FUNCTION claim_credit_link(text, text, text) IS
  'Atomically claim a credit link into credits_bonus with FOR UPDATE on link + user row.';

-- 6) Free-tier users without reset_at get a renewal date so usage UI can show it
UPDATE user_credits
SET
  reset_at = COALESCE(created_at, NOW()) + INTERVAL '1 month',
  updated_at = NOW()
WHERE plan IS NULL
  AND reset_at IS NULL;
