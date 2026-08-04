-- Invite-only access: approved emails, invite tokens, user approval flag
-- Run in Supabase SQL Editor

-- ============================================
-- INVITE TOKENS (single-use links)
-- ============================================
CREATE TABLE IF NOT EXISTS invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_email TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens (token);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_created_at ON invite_tokens (created_at DESC);

-- ============================================
-- APPROVED EMAILS (allowed to use the app)
-- ============================================
CREATE TABLE IF NOT EXISTS approved_emails (
  email TEXT PRIMARY KEY,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  invite_token_id UUID REFERENCES invite_tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_approved_emails_approved_at ON approved_emails (approved_at DESC);

-- ============================================
-- USERS: add approval flag
-- ============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_is_approved ON users (is_approved);
