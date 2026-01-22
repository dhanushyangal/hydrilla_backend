-- ============================================
-- Add UNIQUE constraint for ONE early access per email
-- Only applies to COMPLETED payments
-- ============================================

-- Drop existing index if it exists
DROP INDEX IF EXISTS idx_early_access_payments_email_unique_completed;

-- Create partial unique index: Only ONE completed payment per email
-- This prevents duplicate early access grants
CREATE UNIQUE INDEX idx_early_access_payments_email_unique_completed 
ON early_access_payments (email) 
WHERE payment_status = 'completed';

-- Add comment for documentation
COMMENT ON INDEX idx_early_access_payments_email_unique_completed IS 
'Ensures only ONE completed early access payment per email address';
