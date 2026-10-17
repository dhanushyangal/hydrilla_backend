-- ============================================================
-- 026_app_settings.sql
-- Persistent Admin Settings (GPU gateway URL, active target VM, etc.)
-- Safe / additive. Run in Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on app_settings" ON app_settings;
END
$$;

CREATE POLICY "Service role can do everything on app_settings"
  ON app_settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);
