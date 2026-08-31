-- Pinned Water models for the Engine picker (Settings toggles).
-- Safe / additive. Run in Supabase SQL Editor.

ALTER TABLE user_model_prefs
  ADD COLUMN IF NOT EXISTS enabled_code_models TEXT[];
