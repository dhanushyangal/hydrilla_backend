-- ============================================================================
-- SAFE MIGRATION: Add refund_id column to existing payment_attempts table
-- ============================================================================
-- This script is SAFE to run on existing production database
-- It will NOT:
--   - Delete any data
--   - Modify existing columns
--   - Break existing functionality
-- It will ONLY:
--   - Add refund_id column (if it doesn't exist)
--   - Create index for refund_id (if it doesn't exist)
--   - Update comment (informational only)
-- ============================================================================

-- Step 1: Add refund_id column (only if it doesn't exist)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'payment_attempts' 
        AND column_name = 'refund_id'
    ) THEN
        ALTER TABLE payment_attempts ADD COLUMN refund_id TEXT;
        RAISE NOTICE '✅ Added refund_id column to payment_attempts table';
    ELSE
        RAISE NOTICE 'ℹ️ refund_id column already exists - skipping';
    END IF;
END $$;

-- Step 2: Create index for refund_id (only if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE schemaname = 'public'
        AND tablename = 'payment_attempts' 
        AND indexname = 'idx_payment_attempts_refund_id'
    ) THEN
        CREATE INDEX idx_payment_attempts_refund_id 
        ON payment_attempts(refund_id) 
        WHERE refund_id IS NOT NULL;
        RAISE NOTICE '✅ Created index idx_payment_attempts_refund_id';
    ELSE
        RAISE NOTICE 'ℹ️ Index idx_payment_attempts_refund_id already exists - skipping';
    END IF;
END $$;

-- Step 3: Update status comment (informational only - doesn't affect functionality)
COMMENT ON COLUMN payment_attempts.status IS 
'Status: pending, succeeded, failed, refunded, refund_pending, refund_failed';

-- ============================================================================
-- VERIFICATION: Check if migration was successful
-- ============================================================================
-- Run this query to verify:
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'payment_attempts' AND column_name = 'refund_id';
-- 
-- Expected result: refund_id | text | YES
-- ============================================================================
