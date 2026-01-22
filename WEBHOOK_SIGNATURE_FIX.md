# 🔧 Webhook Signature Verification Fix

## 🚨 Current Problem

**Webhook signature verification failing with 401 Unauthorized**

Error: `{ "error": "Signature verification failed" }`

---

## ✅ Fixes Applied

### 1. Multiple Secret Format Support

The code now tries **multiple methods** to handle the webhook secret:

**Method 1**: Decode base64 part (StandardWebhooks spec)
- If secret is `whsec_xxxxx`, decode `xxxxx` from base64
- Use decoded string as HMAC key

**Method 2**: Use raw base64 part (fallback)
- If secret is `whsec_xxxxx`, use `xxxxx` directly as HMAC key
- Some implementations use it this way

**Method 3**: Use secret as-is (if no `whsec_` prefix)
- Use the full secret directly

### 2. Enhanced Logging

Added detailed logging to help debug:
- Which method is being tried
- Signature prefixes (first 30 chars)
- Secret format being used
- Payload and signed payload previews

---

## 🔍 Debugging Steps

### Step 1: Check Vercel Logs

After deployment, check Vercel Function Logs for:
```
"Verifying webhook signature"
"✅ Webhook signature verification succeeded"
"❌ All webhook signature verification methods failed"
```

### Step 2: Verify Environment Variable

**In Vercel Dashboard → Settings → Environment Variables:**

Make sure `DODO_PAYMENT_WEBHOOK_SECRET` is set to:
```
whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
```

**Important**: Copy the **exact** secret from Dodo Dashboard:
- Go to **Developer → Webhooks**
- Click on your webhook
- Click **"Signing Secret"** dropdown
- Copy the **full secret** (including `whsec_` prefix)

### Step 3: Test Webhook

Make a test payment and check:
1. **Dodo Dashboard → Webhooks → Message Attempts**
   - Should show "Succeeded" (green checkmark)
   - Not "Failed" (red X)

2. **Vercel Function Logs**
   - Look for signature verification logs
   - Check which method succeeded (if any)

---

## 🛠️ If Still Failing

### Option 1: Temporarily Disable Signature Verification (Testing Only)

**⚠️ WARNING: Only for testing! Never use in production!**

Add this to `hydrilla_backend/src/routes/payments.ts` in the webhook handler:

```typescript
// TEMPORARY: Skip signature verification for testing
if (process.env.SKIP_WEBHOOK_VERIFICATION === "true") {
  logger.warn("⚠️ SKIPPING WEBHOOK SIGNATURE VERIFICATION (TESTING ONLY)");
  // Continue processing without verification
} else {
  // Normal verification
  if (!isValid) {
    return sendResponse(401, { error: "Invalid signature" });
  }
}
```

Then in Vercel, add:
```env
SKIP_WEBHOOK_VERIFICATION=true
```

**⚠️ Remove this after testing!**

### Option 2: Use StandardWebhooks Library

Install the official library:
```bash
npm install standardwebhooks
```

Then use it in the webhook handler:
```typescript
import { Webhook } from "standardwebhooks";

const webhook = new Webhook(config.dodoPayment.webhookSecret);

try {
  await webhook.verify(payload, {
    "webhook-id": webhookId,
    "webhook-signature": webhookSignature,
    "webhook-timestamp": webhookTimestamp,
  });
} catch (error) {
  // Invalid signature
}
```

---

## 📋 What to Check

1. ✅ **Secret Format**: Should be `whsec_xxxxx` (full string)
2. ✅ **Secret Value**: Must match Dodo Dashboard exactly
3. ✅ **Raw Body**: Must be exact raw body (not parsed JSON)
4. ✅ **Signature Format**: Should be `v1=<base64_hash>`
5. ✅ **Encoding**: HMAC digest should be base64 (not hex)

---

## 🎯 Expected Behavior After Fix

1. **Webhook receives request** → Logs "Webhook received"
2. **Signature verification** → Logs "Verifying webhook signature"
3. **One method succeeds** → Logs "✅ Webhook signature verification succeeded"
4. **Payment processed** → Logs "Processing payment success webhook"
5. **Database updated** → Payment record created in Supabase

---

**Last Updated**: 2024-01-22
