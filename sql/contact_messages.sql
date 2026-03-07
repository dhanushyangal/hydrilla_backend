-- ============================================================
-- Hydrilla - Contact Form Messages (Supabase)
-- Run this in your Supabase SQL editor
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  TEXT        NOT NULL,
  work_email TEXT        NOT NULL,
  company    TEXT,
  use_case   TEXT        NOT NULL CHECK (use_case IN (
    'Game Development',
    'Film / Animation',
    'Architecture / Interiors',
    'AR / VR / XR',
    'Product Visualization',
    'Other'
  )),
  studio_size TEXT,  -- e.g. "1–5", "6–15", "16–50", "51–200", "200+"
  message    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
  ON contact_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_work_email
  ON contact_messages (work_email);

-- Optional: RLS (allow insert from service role; no public insert if you only use backend)
-- ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Service role can do all" ON contact_messages FOR ALL USING (true);

COMMENT ON TABLE contact_messages IS 'Contact form submissions from the website';
