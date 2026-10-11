-- Migration 021: only the current Starter and Pro products keep those plan names.
-- Does not delete rows or credit balances.
-- Old Creator subscriptions that were renamed to starter are restored to creator.
-- Credit plan labels are cleared for users who do not own an active current product.

-- Replace the product ids below if they differ from .env.local.
-- Starter: DODO_PAYMENT_STARTER_PRODUCT_ID
-- Pro:     DODO_PAYMENT_STUDIO_PRODUCT_ID

UPDATE user_subscriptions
SET plan = 'creator', updated_at = NOW()
WHERE plan = 'starter'
  AND product_id IS DISTINCT FROM 'pdt_0Np2Mb83p2zpWLqj3gtQb'
  AND product_id IS DISTINCT FROM 'pdt_0Np2QWA7b5WM0q13JeQb3';

UPDATE user_credits
SET plan = NULL, updated_at = NOW()
WHERE plan IS NOT NULL
  AND user_id NOT IN (
    SELECT user_id
    FROM user_subscriptions
    WHERE status = 'active'
      AND user_id IS NOT NULL
      AND product_id IN (
        'pdt_0Np2Mb83p2zpWLqj3gtQb',
        'pdt_0Np2QWA7b5WM0q13JeQb3'
      )
  );
