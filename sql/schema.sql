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
  plan TEXT NOT NULL CHECK (plan = ANY (ARRAY['creator'::text, 'studio'::text, 'unknown'::text])),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'on_hold'::text, 'cancelled'::text, 'expired'::text, 'failed'::text])),
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
