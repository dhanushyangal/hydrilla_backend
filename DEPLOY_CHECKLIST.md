# ✅ Deployment Checklist - Webhook Fix

## Changes Made

### 1. Fixed Vercel Serverless Function (`api/index.ts`)
- ✅ Added payments router import
- ✅ Registered payments routes
- ✅ Added raw body parser for webhook
- ✅ Added webhook headers to CORS

### 2. Cleaned Up
- ✅ Removed unused `create-webhook.ts` script (webhook already exists in dashboard)

---

## Environment Variables in Vercel

**Verify these are set in Vercel Dashboard → Settings → Environment Variables:**

```env
DODO_PAYMENT_API_KEY=your_api_key
DODO_PAYMENT_MODE=test
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
DODO_PAYMENT_PRODUCT_ID=your_product_id
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

---

## Deploy Steps

1. **Commit changes:**
   ```bash
   git add hydrilla_backend/api/index.ts
   git commit -m "Fix: Add payments router to Vercel serverless function"
   git push
   ```

2. **Vercel auto-deploys** (if connected to Git)

3. **Verify webhook endpoint:**
   ```bash
   curl -X POST https://hydrilla-backend.vercel.app/api/payments/webhook/dodo
   ```
   **Expected**: `401` (missing headers) or `200` - **NOT** `404`

---

## After Deployment

1. **Check Dodo Dashboard → Webhooks**
   - New webhook attempts should show "Succeeded" (not "Failed")

2. **Test with a payment**
   - Make a test payment
   - Check webhook delivery in dashboard
   - Verify payment record in Supabase

3. **Sync missed payments** (if needed):
   ```bash
   curl -X POST https://hydrilla-backend.vercel.app/api/payments/sync/pay_0NWp86g6315yOlJpU7U4N
   ```

---

## Files Changed

- ✅ `hydrilla_backend/api/index.ts` - Added payments router
- ✅ `hydrilla_backend/scripts/create-webhook.ts` - Removed (unused)

**No other files affected** ✅
