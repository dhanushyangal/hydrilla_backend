-- ============================================================================
-- HYDRILLA EARLY ACCESS - COMPLETE DATABASE SCHEMA
-- ============================================================================
-- This schema implements:
-- 1. Webhook deduplication (using webhook_id)
-- 2. One-time access per email (UNIQUE constraint)
-- 3. Payment ID tracking (UNIQUE constraint)
-- 4. Clean audit trail
-- ============================================================================

-- ============================================================================
-- STEP 1: DROP OLD TABLES (Clean Slate)
-- ============================================================================
-- Drop old table if exists (backup data first if needed!)
DROP TABLE IF EXISTS early_access_payments CASCADE;
DROP TABLE IF EXISTS webhook_events CASCADE;

-- ============================================================================
-- STEP 2: CREATE WEBHOOK EVENTS TABLE (For Deduplication)
-- ============================================================================
-- This table prevents processing the same webhook twice
-- Dodo Payment may retry webhooks, so we track webhook_id

CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id TEXT UNIQUE NOT NULL,  -- From webhook-id header (UNIQUE prevents duplicates)
    event_type TEXT NOT NULL,          -- e.g., 'payment.succeeded', 'payment.failed'
    payload JSONB,                     -- Full webhook payload for audit
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookups
CREATE INDEX idx_webhook_events_webhook_id ON webhook_events(webhook_id);
CREATE INDEX idx_webhook_events_event_type ON webhook_events(event_type);
CREATE INDEX idx_webhook_events_created_at ON webhook_events(created_at DESC);

-- ============================================================================
-- STEP 3: CREATE EARLY ACCESS TABLE (One-Time Per Email)
-- ============================================================================
-- This is the main table tracking who has early access
-- UNIQUE constraint on email ensures ONE access per email

CREATE TABLE early_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- User identification
    email TEXT UNIQUE NOT NULL,        -- ONE access per email (enforced by DB)
    user_id TEXT,                       -- Clerk user ID (if logged in)
    customer_name TEXT,                 -- Customer name from payment
    
    -- Payment tracking
    payment_id TEXT UNIQUE,             -- Dodo Payment ID (UNIQUE prevents double-recording)
    checkout_session_id TEXT,           -- Checkout session ID
    
    -- Status
    status TEXT NOT NULL DEFAULT 'granted',  -- 'granted', 'revoked', 'refunded'
    
    -- Amount info
    amount DECIMAL(10, 2),              -- Amount in dollars
    amount_cents INTEGER,               -- Original amount in cents
    currency TEXT DEFAULT 'USD',
    
    -- Timestamps
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Audit trail
    webhook_id TEXT REFERENCES webhook_events(webhook_id),  -- Link to webhook that granted access
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for performance
CREATE INDEX idx_early_access_email ON early_access(email);
CREATE INDEX idx_early_access_user_id ON early_access(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_early_access_payment_id ON early_access(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_early_access_status ON early_access(status);
CREATE INDEX idx_early_access_granted_at ON early_access(granted_at DESC);

-- ============================================================================
-- STEP 4: CREATE PAYMENT ATTEMPTS TABLE (Optional - For Audit)
-- ============================================================================
-- Tracks all payment attempts (including failed ones)
-- Useful for debugging and customer support

CREATE TABLE payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    user_id TEXT,
    payment_id TEXT,
    refund_id TEXT,                      -- Dodo Refund ID (for refund tracking)
    checkout_session_id TEXT,
    status TEXT NOT NULL,               -- 'pending', 'succeeded', 'failed', 'refunded', 'refund_pending', 'refund_failed'
    amount_cents INTEGER,
    currency TEXT DEFAULT 'USD',
    error_message TEXT,
    webhook_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_payment_attempts_email ON payment_attempts(email);
CREATE INDEX idx_payment_attempts_payment_id ON payment_attempts(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_payment_attempts_refund_id ON payment_attempts(refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX idx_payment_attempts_status ON payment_attempts(status);
CREATE INDEX idx_payment_attempts_created_at ON payment_attempts(created_at DESC);

-- ============================================================================
-- STEP 5: ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE early_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for backend)
CREATE POLICY "Service role full access on webhook_events" ON webhook_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on early_access" ON early_access
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on payment_attempts" ON payment_attempts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users can read their own early_access status
CREATE POLICY "Users can read own early_access" ON early_access
    FOR SELECT TO authenticated
    USING (user_id = auth.uid()::text OR email = auth.email());

-- ============================================================================
-- STEP 6: HELPER FUNCTIONS
-- ============================================================================

-- Function to check if email has access (for quick lookups)
CREATE OR REPLACE FUNCTION has_early_access(check_email TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM early_access 
        WHERE email = check_email 
        AND status = 'granted'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to grant access (with conflict handling)
CREATE OR REPLACE FUNCTION grant_early_access(
    p_email TEXT,
    p_user_id TEXT DEFAULT NULL,
    p_customer_name TEXT DEFAULT NULL,
    p_payment_id TEXT DEFAULT NULL,
    p_checkout_session_id TEXT DEFAULT NULL,
    p_amount DECIMAL DEFAULT NULL,
    p_amount_cents INTEGER DEFAULT NULL,
    p_currency TEXT DEFAULT 'USD',
    p_webhook_id TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    success BOOLEAN,
    status TEXT,
    access_id UUID,
    message TEXT
) AS $$
DECLARE
    v_access_id UUID;
    v_existing_id UUID;
BEGIN
    -- Check if already has access
    SELECT id INTO v_existing_id 
    FROM early_access 
    WHERE email = p_email AND status = 'granted';
    
    IF v_existing_id IS NOT NULL THEN
        RETURN QUERY SELECT 
            false::BOOLEAN, 
            'ALREADY_HAS_ACCESS'::TEXT, 
            v_existing_id, 
            'Email already has early access'::TEXT;
        RETURN;
    END IF;
    
    -- Try to insert
    BEGIN
        INSERT INTO early_access (
            email, user_id, customer_name, payment_id, checkout_session_id,
            amount, amount_cents, currency, webhook_id, metadata, status
        ) VALUES (
            p_email, p_user_id, p_customer_name, p_payment_id, p_checkout_session_id,
            p_amount, p_amount_cents, p_currency, p_webhook_id, p_metadata, 'granted'
        )
        RETURNING id INTO v_access_id;
        
        RETURN QUERY SELECT 
            true::BOOLEAN, 
            'ACCESS_GRANTED'::TEXT, 
            v_access_id, 
            'Early access granted successfully'::TEXT;
    EXCEPTION WHEN unique_violation THEN
        -- Race condition - someone else inserted first
        SELECT id INTO v_existing_id 
        FROM early_access 
        WHERE email = p_email;
        
        RETURN QUERY SELECT 
            false::BOOLEAN, 
            'ALREADY_HAS_ACCESS'::TEXT, 
            v_existing_id, 
            'Email already has early access (race condition handled)'::TEXT;
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STEP 7: COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE webhook_events IS 'Stores all received webhooks for deduplication. webhook_id is UNIQUE to prevent processing same webhook twice.';
COMMENT ON TABLE early_access IS 'Main table for early access grants. email is UNIQUE to ensure one access per email.';
COMMENT ON TABLE payment_attempts IS 'Audit log of all payment attempts including failed ones.';
COMMENT ON FUNCTION has_early_access IS 'Quick check if an email has early access';
COMMENT ON FUNCTION grant_early_access IS 'Safely grants early access with conflict handling';

-- ============================================================================
-- DONE! 
-- ============================================================================
-- Summary of constraints:
-- 1. webhook_events.webhook_id UNIQUE - Prevents processing same webhook twice
-- 2. early_access.email UNIQUE - ONE access per email
-- 3. early_access.payment_id UNIQUE - ONE record per payment
-- ============================================================================
