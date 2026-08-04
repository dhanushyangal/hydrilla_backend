-- ============================================================================
-- MIGRATION: Add refund_id column to payment_attempts table
-- ============================================================================
-- Run this if you already have the early_access_complete.sql schema
-- This adds support for tracking refund IDs

-- Add refund_id column (if it doesn't exist)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'payment_attempts' 
        AND column_name = 'refund_id'
    ) THEN
        ALTER TABLE payment_attempts ADD COLUMN refund_id TEXT;
        CREATE INDEX idx_payment_attempts_refund_id ON payment_attempts(refund_id) WHERE refund_id IS NOT NULL;
        RAISE NOTICE 'Added refund_id column to payment_attempts table';
    ELSE
        RAISE NOTICE 'refund_id column already exists';
    END IF;
END $$;

-- Update status comment (informational only)
COMMENT ON COLUMN payment_attempts.status IS 'Status: pending, succeeded, failed, refunded, refund_pending, refund_failed';
