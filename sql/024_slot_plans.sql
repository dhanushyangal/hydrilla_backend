-- Migration 024: Slot plans.
-- One UTC hour is one worldwide slot. Each country only changes the clock label.
-- Slot: 1 hour, 2 people. Slot Pro: 2 hours, 4 people. Seats are counted per plan.
-- Does not change credit balances or Starter / Pro rows.

ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_plan_check;

ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_plan_check
  CHECK (plan = ANY (ARRAY[
    'starter'::text,
    'pro'::text,
    'slot'::text,
    'slot_pro'::text,
    'creator'::text,
    'studio'::text,
    'unknown'::text
  ]));

CREATE TABLE IF NOT EXISTS slot_bookings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('slot', 'slot_pro')),
  timezone TEXT NOT NULL,
  start_hour SMALLINT NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  duration_hours SMALLINT NOT NULL CHECK (duration_hours IN (1, 2)),
  changed_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row = one person holding one UTC hour on one Slot plan.
-- Slot seats and Slot Pro seats are counted separately.
CREATE TABLE IF NOT EXISTS slot_hours (
  hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('slot', 'slot_pro')),
  PRIMARY KEY (hour, user_id)
);

CREATE INDEX IF NOT EXISTS slot_hours_user_idx ON slot_hours (user_id);

ALTER TABLE slot_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_hours ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION set_slot(
  p_user_id text,
  p_plan text,
  p_timezone text,
  p_start_hour int,
  p_today date,
  p_week_monday date,
  p_capacity int
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_duration int;
  v_existing slot_bookings%ROWTYPE;
  v_has boolean;
  v_offset int;
  v_hour int;
  v_hours int[] := ARRAY[]::int[];
  v_count int;
BEGIN
  IF p_plan = 'slot' THEN
    v_duration := 1;
  ELSIF p_plan = 'slot_pro' THEN
    v_duration := 2;
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'not_slot_plan', 'error', 'This account is not on a Slot plan.');
  END IF;

  IF p_capacity IS NULL OR p_capacity < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'slot_book_failed', 'error', 'Slot capacity is not configured.');
  END IF;

  IF p_timezone IS NULL OR btrim(p_timezone) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'timezone', 'error', 'We could not read your timezone. Refresh and try again.');
  END IF;

  IF p_start_hour IS NULL OR p_start_hour < 0 OR p_start_hour > 23 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_hour', 'error', 'Choose a start time from the list.');
  END IF;

  FOR v_offset IN 0 .. (v_duration - 1) LOOP
    v_hours := v_hours || ((p_start_hour + v_offset) % 24);
  END LOOP;

  SELECT * INTO v_existing FROM slot_bookings WHERE user_id = p_user_id FOR UPDATE;
  v_has := FOUND;

  IF v_has
     AND v_existing.start_hour = p_start_hour
     AND v_existing.duration_hours = v_duration THEN
    RETURN jsonb_build_object('ok', false, 'code', 'same_hours', 'error', 'Those are already your hours.');
  END IF;

  IF v_has AND v_existing.changed_on IS NOT NULL AND v_existing.changed_on >= p_week_monday THEN
    RETURN jsonb_build_object('ok', false, 'code', 'change_used', 'error', 'You can change your hours once this week. The next change is on Monday.');
  END IF;

  -- Lock in hour order so two bookings cannot pass the seat count together.
  FOR v_hour IN 0 .. 23 LOOP
    IF v_hour = ANY (v_hours) THEN
      PERFORM pg_advisory_xact_lock(840240, v_hour);
    END IF;
  END LOOP;

  FOREACH v_hour IN ARRAY v_hours LOOP
    SELECT count(*) INTO v_count
    FROM slot_hours
    WHERE hour = v_hour AND plan = p_plan AND user_id <> p_user_id;
    IF v_count >= p_capacity THEN
      RETURN jsonb_build_object('ok', false, 'code', 'hour_taken', 'hour', v_hour, 'error', 'That time is already booked.');
    END IF;
  END LOOP;

  DELETE FROM slot_hours WHERE user_id = p_user_id;

  FOREACH v_hour IN ARRAY v_hours LOOP
    INSERT INTO slot_hours (hour, user_id, plan)
    VALUES (v_hour, p_user_id, p_plan);
  END LOOP;

  INSERT INTO slot_bookings (user_id, plan, timezone, start_hour, duration_hours, changed_on)
  VALUES (
    p_user_id,
    p_plan,
    p_timezone,
    p_start_hour,
    v_duration,
    CASE WHEN v_has THEN p_today ELSE NULL END
  )
  ON CONFLICT (user_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    timezone = EXCLUDED.timezone,
    start_hour = EXCLUDED.start_hour,
    duration_hours = EXCLUDED.duration_hours,
    changed_on = EXCLUDED.changed_on,
    updated_at = NOW();

  RETURN jsonb_build_object('ok', true);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'hour_taken', 'error', 'That time was just taken. Pick another hour.');
END;
$$;

REVOKE ALL ON FUNCTION set_slot(text, text, text, int, date, date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_slot(text, text, text, int, date, date, int) TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON slot_bookings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON slot_hours TO service_role;
