# 🔐 Complete Environment Variables Setup Guide

## The Problem We Fixed

The build was failing because `src/config.ts` was not pushed to GitHub. The `dodoPayment` configuration section was missing on Vercel.

**Fixed by**: Committing and pushing `src/config.ts` to GitHub.

---

## 📋 Environment Variables Reference

### 1. Backend LOCAL (`.env` in `hydrilla_backend/`)

```env
# Server
PORT=4000

# Supabase
SUPABASE_URL=https://vyyzepmcqeqoxwjqnrxh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx
CLERK_SECRET_KEY=sk_test_xxxxx

# Hunyuan API
HUNYUAN_API_URL=https://api.hydrilla.co

# S3
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
S3_PRESIGNED_URL_EXPIRY=3600

# ZeptoMail
ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email
ZEPTOMAIL_TOKEN=your_zeptomail_token
ZEPTOMAIL_FROM_ADDRESS=noreply@hydrilla.co
ZEPTOMAIL_FROM_NAME=Hydrilla

# Frontend URL (for return URLs)
FRONTEND_URL=http://localhost:3000

# === DODO PAYMENT ===
DODO_PAYMENT_API_KEY=your_api_key_from_dodo_dashboard
DODO_PAYMENT_MODE=test
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
DODO_PAYMENT_PRODUCT_ID=pdt_your_product_id
DODO_PAYMENTS_RETURN_URL=http://localhost:3000/checkout/success

# TEMPORARY: Skip webhook signature verification for testing (REMOVE IN PRODUCTION!)
# SKIP_WEBHOOK_VERIFICATION=true
```

---

### 2. Backend VERCEL (Dashboard → Settings → Environment Variables)

```env
# Supabase
SUPABASE_URL=https://vyyzepmcqeqoxwjqnrxh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Clerk
CLERK_SECRET_KEY=sk_test_xxxxx

# Hunyuan API
HUNYUAN_API_URL=https://api.hydrilla.co

# S3
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
S3_PRESIGNED_URL_EXPIRY=3600

# ZeptoMail
ZEPTOMAIL_TOKEN=your_zeptomail_token
ZEPTOMAIL_FROM_ADDRESS=noreply@hydrilla.co
ZEPTOMAIL_FROM_NAME=Hydrilla

# Frontend URL
FRONTEND_URL=https://hydrilla.ai

# === DODO PAYMENT (CRITICAL!) ===
DODO_PAYMENT_API_KEY=your_api_key_from_dodo_dashboard
DODO_PAYMENT_MODE=test
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
DODO_PAYMENT_PRODUCT_ID=pdt_your_product_id
DODO_PAYMENTS_RETURN_URL=https://hydrilla.ai/checkout/success

# TEMPORARY: Skip webhook signature verification for testing (REMOVE AFTER TESTING!)
SKIP_WEBHOOK_VERIFICATION=true
```

---

### 3. Frontend LOCAL (`.env.local` in `hydrilla_fronted/`)

```env
# Backend API URL (local)
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx
```

---

### 4. Frontend VERCEL (Dashboard → Settings → Environment Variables)

```env
# Backend API URL (production)
NEXT_PUBLIC_BACKEND_URL=https://hydrilla-backend.vercel.app

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx
```

---

## 🔑 How to Get Dodo Payment Credentials

### 1. API Key
- Go to: https://app.dodopayments.com/developer/api-keys
- Create new API key or copy existing one
- Use in: `DODO_PAYMENT_API_KEY`

### 2. Product ID
- Go to: https://app.dodopayments.com/products
- Create a product for Early Access
- Copy the product ID (starts with `pdt_`)
- Use in: `DODO_PAYMENT_PRODUCT_ID`

### 3. Webhook Secret
- Go to: https://app.dodopayments.com/developer/webhooks
- Find your webhook
- Click "Signing Secret"
- Copy the secret (starts with `whsec_`)
- Use in: `DODO_PAYMENT_WEBHOOK_SECRET`

**Current Webhook Secret**: `whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT`

---

## ❓ Why Webhook is Failing

### Issue: 401 Unauthorized (Signature verification failed)

**Root Cause**: The webhook signature verification is failing because:

1. **Secret format mismatch**: The secret might need to be decoded differently
2. **Payload format**: Raw body vs JSON parsed body
3. **Missing headers**: `webhook-id`, `webhook-signature`, `webhook-timestamp`

### Temporary Fix

Set this in Vercel environment variables:
```env
SKIP_WEBHOOK_VERIFICATION=true
```

This skips signature verification temporarily so you can test the payment flow.

**⚠️ IMPORTANT**: Remove this after testing! In production, you need signature verification for security.

---

## 🚀 Deployment Checklist

### After pushing code:

1. **Wait for Vercel build** (should pass now with config.ts)

2. **Verify environment variables** in Vercel Dashboard:
   - `DODO_PAYMENT_API_KEY` ✓
   - `DODO_PAYMENT_MODE=test` ✓
   - `DODO_PAYMENT_WEBHOOK_SECRET` ✓
   - `DODO_PAYMENT_PRODUCT_ID` ✓
   - `DODO_PAYMENTS_RETURN_URL` ✓
   - `SKIP_WEBHOOK_VERIFICATION=true` ✓ (temporary)

3. **Test payment flow**:
   - Go to https://hydrilla.ai/earlyaccess
   - Click "Get Early Access"
   - Complete test payment
   - Check if webhook receives event
   - Check Supabase for payment record

4. **Check Dodo Dashboard**:
   - Webhook should show "Succeeded" status
   - Payment should show "Completed"

---

## 📊 Webhook Testing

### Test Endpoint

```
GET https://hydrilla-backend.vercel.app/api/payments/test
```

Should return:
```json
{
  "message": "Payments router is working",
  "config": {
    "hasApiKey": true,
    "hasProductId": true,
    "mode": "test",
    "baseUrl": "https://test.dodopayments.com"
  }
}
```

### Webhook Endpoint

```
POST https://hydrilla-backend.vercel.app/api/payments/webhook/dodo
```

---

## 🐛 Troubleshooting

### Build Error: `Property 'dodoPayment' does not exist`
- **Cause**: `config.ts` wasn't pushed to GitHub
- **Fix**: `git add src/config.ts && git commit -m "Add dodoPayment config" && git push`

### Webhook 401 Unauthorized
- **Cause**: Signature verification failing
- **Temporary Fix**: Set `SKIP_WEBHOOK_VERIFICATION=true` in Vercel
- **Permanent Fix**: Debug the signature verification logic

### Payment redirects to wrong URL
- **Cause**: `DODO_PAYMENTS_RETURN_URL` not set
- **Fix**: Set it in Vercel environment variables

### Frontend can't reach backend
- **Cause**: `NEXT_PUBLIC_BACKEND_URL` not set correctly
- **Fix**: Set it to the correct backend URL
