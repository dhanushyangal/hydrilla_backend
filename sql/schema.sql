-- ============================================
-- Hydrilla — canonical schema (post invite cleanup)
-- Context / new-env reference. Prefer migrations for existing DBs.
-- Run 004_drop_unused_invite_and_columns.sql on existing projects.
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT 'Untitled Workspace',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  status VARCHAR(16) NOT NULL DEFAULT 'WAIT',
  prompt TEXT,
  image_url TEXT,
  generate_type VARCHAR(32) NOT NULL DEFAULT 'Normal',
  result_glb_url TEXT,
  preview_image_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chat_id UUID REFERENCES chats(id),
  workspace_id UUID REFERENCES workspaces(id),
  parent_job_id VARCHAR(64) REFERENCES jobs(id),
  source_images JSONB,
  credits_used INTEGER NOT NULL DEFAULT 0,
  engine TEXT DEFAULT 'trilles',
  result_kind TEXT DEFAULT 'glb',
  llm_model TEXT,
  llm_provider TEXT,
  factory_code TEXT,
  sculpt_spec JSONB,
  sculpt_pass TEXT,
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  llm_total_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON jobs (workspace_id);

CREATE TABLE IF NOT EXISTS job_parents (
  job_id VARCHAR(64) NOT NULL REFERENCES jobs(id),
  parent_job_id VARCHAR(64) NOT NULL REFERENCES jobs(id),
  slot INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, parent_job_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(id),
  customer_name TEXT,
  plan TEXT NOT NULL CHECK (plan = ANY (ARRAY['starter'::text, 'pro'::text, 'slot'::text, 'slot_pro'::text, 'creator'::text, 'studio'::text, 'unknown'::text])),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'on_hold'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text, 'expired'::text, 'failed'::text])),
  dodo_subscription_id TEXT NOT NULL UNIQUE,
  dodo_customer_id TEXT,
  product_id TEXT,
  recurring_amount INTEGER,
  currency TEXT DEFAULT 'INR',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT UNIQUE REFERENCES users(id),
  plan TEXT,
  credits_total INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT REFERENCES user_subscriptions(dodo_subscription_id),
  reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  email TEXT,
  dodo_payment_id TEXT NOT NULL UNIQUE,
  dodo_subscription_id TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'refunded'::text])),
  plan TEXT,
  webhook_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  work_email TEXT NOT NULL,
  company TEXT,
  use_case TEXT NOT NULL CHECK (use_case = ANY (ARRAY['Game Development'::text, 'Film / Animation'::text, 'Architecture / Interiors'::text, 'AR / VR / XR'::text, 'Product Visualization'::text, 'Other'::text])),
  studio_size TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider = ANY (ARRAY['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text, 'cursor'::text])),
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  last4 TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status = ANY (ARRAY['unchecked'::text, 'valid'::text, 'invalid'::text])),
  last_error TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_model_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  default_mesh_model TEXT DEFAULT 'trilles',
  default_code_model TEXT,
  enabled_code_models TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  headline        TEXT,
  slug            TEXT NOT NULL UNIQUE,
  excerpt         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  cover_image     TEXT,
  category        TEXT NOT NULL DEFAULT 'General',
  author          TEXT NOT NULL DEFAULT 'Hydrilla',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published')),
  published_at    TIMESTAMPTZ,
  seo_title       TEXT,
  seo_description TEXT,
  seo_image       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blog_posts_slug_idx ON blog_posts (slug);
CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON blog_posts (status);
CREATE INDEX IF NOT EXISTS blog_posts_published_at_idx ON blog_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_category_idx ON blog_posts (category);
CREATE INDEX IF NOT EXISTS blog_posts_status_published_at_idx
  ON blog_posts (status, published_at DESC);
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
