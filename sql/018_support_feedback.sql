-- ============================================================
-- Hydrilla - Support & Feedback Tickets Table (Supabase)
-- Run this in your Supabase SQL editor
-- ============================================================

CREATE TABLE IF NOT EXISTS support_feedback (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('issue', 'feedback')),
  request_type    TEXT,       -- e.g. 'Issue', 'Billing', 'Account & Data Management', 'Question'
  message         TEXT        NOT NULL,
  attachment_url  TEXT,
  attachment_name TEXT,
  user_id         TEXT        REFERENCES users(id) ON DELETE SET NULL,
  user_email      TEXT,
  user_name       TEXT,
  page_url        TEXT,
  metadata        JSONB       DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_feedback_created_at
  ON support_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_feedback_type
  ON support_feedback (type);
CREATE INDEX IF NOT EXISTS idx_support_feedback_status
  ON support_feedback (status);
CREATE INDEX IF NOT EXISTS idx_support_feedback_user_email
  ON support_feedback (user_email);

COMMENT ON TABLE support_feedback IS 'User-submitted support tickets, bug reports, and product feedback';
