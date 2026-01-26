-- ============================================
-- Migration: Add Chats Table for ChatGPT-like Interface
-- ============================================
-- This migration adds a chats table to group jobs into conversations
-- Each chat can contain multiple jobs (like ChatGPT conversations)

-- ============================================
-- CHATS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for chats
CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats (user_id);
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats (updated_at DESC);

-- ============================================
-- ADD chat_id COLUMN TO JOBS TABLE
-- ============================================
-- Add chat_id column to jobs table (nullable for backward compatibility)
ALTER TABLE jobs 
  ADD COLUMN IF NOT EXISTS chat_id UUID REFERENCES chats(id) ON DELETE SET NULL;

-- Index for chat_id
CREATE INDEX IF NOT EXISTS idx_jobs_chat_id ON jobs (chat_id) WHERE chat_id IS NOT NULL;

-- ============================================
-- DROP EXISTING CHAT POLICIES (if any)
-- ============================================
DO $$
BEGIN
  -- Drop chats policies
  DROP POLICY IF EXISTS "Service role can do everything on chats" ON chats;
  DROP POLICY IF EXISTS "Users can read their own chats" ON chats;
  DROP POLICY IF EXISTS "Users can insert their own chats" ON chats;
  DROP POLICY IF EXISTS "Users can update their own chats" ON chats;
  DROP POLICY IF EXISTS "Users can delete their own chats" ON chats;
END
$$;

-- ============================================
-- ENABLE ROW LEVEL SECURITY FOR CHATS
-- ============================================
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS POLICIES FOR CHATS
-- ============================================

-- Policy: Service role bypasses RLS (for backend API)
CREATE POLICY "Service role can do everything on chats"
  ON chats
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy: Users can read their own chats
CREATE POLICY "Users can read their own chats"
  ON chats
  FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Policy: Users can insert chats for themselves
CREATE POLICY "Users can insert their own chats"
  ON chats
  FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Policy: Users can update their own chats
CREATE POLICY "Users can update their own chats"
  ON chats
  FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub')
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Policy: Users can delete their own chats
CREATE POLICY "Users can delete their own chats"
  ON chats
  FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ============================================
-- TRIGGER: Update updated_at for chats
-- ============================================
DROP TRIGGER IF EXISTS update_chats_updated_at ON chats;
CREATE TRIGGER update_chats_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- Chats table created with RLS policies
-- Jobs table now has chat_id column
-- All existing jobs will have chat_id = NULL (can be migrated later if needed)
