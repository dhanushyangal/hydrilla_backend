# 🔄 Switching from Test Mode to Live Mode - Dodo Payments

## ⚠️ Important Notes

According to Dodo Payments documentation:
- **Test Mode** and **Live Mode** have **separate data** (environment-dependent)
- API Keys, Products, Webhooks are **independent** in each mode
- You need to create everything again in Live Mode dashboard
- Live Mode is only available after **Identity Verification** and **Business Verification**

---

## 📋 Step-by-Step Checklist

### 1. **Verify Live Mode Access** ✅

Before switching, ensure:
- ✅ Identity Verification completed
- ✅ Business Verification completed
- ✅ Live Mode is enabled in Dodo Dashboard

**Check**: Go to Dodo Dashboard → Toggle "Test Mode" OFF (should show "Live Mode")

---

### 2. **Get Live Mode Credentials from Dodo Dashboard**

#### A. **Live API Key**
1. Go to Dodo Dashboard (make sure you're in **Live Mode**, not Test Mode)
2. Navigate to **Developer** → **API Keys**
3. Click **"Create New API Key"** or use existing Live API key
4. Copy the **Live API Key** (different from test key)

#### B. **Live Product ID**
1. In **Live Mode** dashboard, go to **Products**
2. Create your Early Access product (if not already created):
   - Name: "Hydrilla Early Access" (or your product name)
   - Price: Your desired price
   - Type: Subscription or One-time
3. Copy the **Product ID** (starts with `prod_`)

**⚠️ Important**: Product IDs are different in Test vs Live mode!

#### C. **Live Webhook Secret**
1. In **Live Mode** dashboard, go to **Developer** → **Webhooks**
2. Create a new webhook (if not exists):
   - **URL**: `https://hydrilla-backend.vercel.app/api/payments/webhook/dodo`
   - **Events**: Select `payment.succeeded`, `payment.failed`, `refund.succeeded`, `refund.failed`
3. Copy the **Webhook Signing Secret** (starts with `whsec_`)

**⚠️ Important**: Webhook secrets are different in Test vs Live mode!

---

### 3. **Update Environment Variables**

#### A. **Backend Local `.env`** (if you use it)

```env
# Change from test to live
DODO_PAYMENT_API_KEY=your_live_api_key_here
DODO_PAYMENT_MODE=live
DODO_PAYMENT_WEBHOOK_SECRET=whsec_your_live_webhook_secret
DODO_PAYMENT_PRODUCT_ID=prod_your_live_product_id
DODO_PAYMENTS_RETURN_URL=https://hydrilla.ai/checkout/success
```

#### B. **Vercel Environment Variables** (CRITICAL - This is what matters for production)

Go to: **Vercel Dashboard** → **Your Project** → **Settings** → **Environment Variables**

Update these variables:

```env
# OLD (Test Mode) → NEW (Live Mode)
DODO_PAYMENT_API_KEY=your_live_api_key_here          # ← Change to Live API key
DODO_PAYMENT_MODE=live                                # ← Change from "test" to "live"
DODO_PAYMENT_WEBHOOK_SECRET=whsec_your_live_secret   # ← Change to Live webhook secret
DODO_PAYMENT_PRODUCT_ID=prod_your_live_product_id     # ← Change to Live product ID
DODO_PAYMENTS_RETURN_URL=https://hydrilla.ai/checkout/success  # ← Ensure production URL
```

**⚠️ Important**: After updating Vercel environment variables, you **MUST redeploy** for changes to take effect!

---

### 4. **What Changes Automatically**

The code automatically handles these based on `DODO_PAYMENT_MODE`:

✅ **Base URL**: 
- Test: `https://test.dodopayments.com`
- Live: `https://live.dodopayments.com` (automatically set in `config.ts`)

✅ **API Client**: Automatically uses the correct base URL based on mode

---

### 5. **After Updating Environment Variables**

1. **Redeploy Backend** (Vercel):
   - Go to Vercel Dashboard → Deployments
   - Click "Redeploy" on the latest deployment
   - OR push a new commit to trigger auto-deploy

2. **Verify Webhook**:
   ```bash
   curl -X POST https://hydrilla-backend.vercel.app/api/payments/webhook/dodo
   ```
   Expected: `401` (missing headers) or `200` - **NOT** `404`

3. **Test a Live Payment**:
   - Make a small test payment with a real card
   - Check webhook delivery in Dodo Dashboard (Live Mode)
   - Verify payment record in Supabase

---

### 6. **Environment Variables Summary**

| Variable | Test Mode Value | Live Mode Value | Where to Get |
|----------|----------------|-----------------|--------------|
| `DODO_PAYMENT_API_KEY` | Test API key | **Live API key** | Dashboard → Developer → API Keys (Live Mode) |
| `DODO_PAYMENT_MODE` | `test` | **`live`** | Just change the value |
| `DODO_PAYMENT_WEBHOOK_SECRET` | Test webhook secret | **Live webhook secret** | Dashboard → Developer → Webhooks (Live Mode) |
| `DODO_PAYMENT_PRODUCT_ID` | Test product ID | **Live product ID** | Dashboard → Products (Live Mode) |
| `DODO_PAYMENTS_RETURN_URL` | `http://localhost:3000/...` | **`https://hydrilla.ai/...`** | Production URL |

---

### 7. **Verification Checklist**

After switching to Live Mode, verify:

- [ ] `DODO_PAYMENT_MODE=live` in Vercel
- [ ] `DODO_PAYMENT_API_KEY` is Live key (not test key)
- [ ] `DODO_PAYMENT_WEBHOOK_SECRET` is Live secret (from Live Mode dashboard)
- [ ] `DODO_PAYMENT_PRODUCT_ID` is Live product ID (from Live Mode dashboard)
- [ ] `DODO_PAYMENTS_RETURN_URL` is production URL (`https://hydrilla.ai/...`)
- [ ] Backend redeployed after env changes
- [ ] Webhook endpoint responds (not 404)
- [ ] Test payment works in Live Mode
- [ ] Webhook delivery shows "Succeeded" in Live Mode dashboard

---

### 8. **Common Issues**

#### Issue: "Webhook verification failed"
**Fix**: Ensure `DODO_PAYMENT_WEBHOOK_SECRET` matches the secret from **Live Mode** dashboard

#### Issue: "Product not found"
**Fix**: Ensure `DODO_PAYMENT_PRODUCT_ID` is from **Live Mode** dashboard (not test mode)

#### Issue: "Invalid API key"
**Fix**: Ensure `DODO_PAYMENT_API_KEY` is from **Live Mode** dashboard

#### Issue: "Changes not taking effect"
**Fix**: **Redeploy** Vercel after updating environment variables!

---

## ✅ Summary

**Yes, just changing IDs, keys, and webhooks is enough!** But remember:

1. ✅ Get **Live Mode** credentials (API key, product ID, webhook secret)
2. ✅ Update **Vercel environment variables** (not just local `.env`)
3. ✅ Change `DODO_PAYMENT_MODE` from `test` to `live`
4. ✅ Update `DODO_PAYMENTS_RETURN_URL` to production URL
5. ✅ **Redeploy** Vercel backend after changes
6. ✅ Test with a real payment in Live Mode

The code automatically handles the base URL switch based on `DODO_PAYMENT_MODE`! 🎉

---

**Last Updated**: 2025-01-23
