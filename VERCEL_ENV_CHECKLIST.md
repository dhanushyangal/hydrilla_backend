# ✅ Vercel Environment Variables Checklist

## 🔑 Required Environment Variables

**Go to**: Vercel Dashboard → Your Project → Settings → Environment Variables

### Dodo Payment Configuration

```env
DODO_PAYMENT_API_KEY=your_api_key_here
DODO_PAYMENT_MODE=test
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
DODO_PAYMENT_PRODUCT_ID=your_product_id_here
DODO_PAYMENTS_RETURN_URL=https://hydrilla.ai/checkout/success
```

### ⚠️ Critical: Webhook Secret

**Get from**: Dodo Dashboard → Developer → Webhooks → Your Webhook → Signing Secret

**Format**: `whsec_xxxxx` (must include `whsec_` prefix)

**Current Secret** (from dashboard): `whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT`

**Verify**:
1. Copy the **exact** secret from Dodo Dashboard
2. Paste it into Vercel environment variable
3. Make sure there are **no extra spaces** before or after
4. Make sure it starts with `whsec_`

---

## 🧪 Temporary Testing (Optional)

**⚠️ ONLY FOR TESTING - REMOVE AFTER FIXING!**

To temporarily bypass signature verification for testing:

```env
SKIP_WEBHOOK_VERIFICATION=true
```

**After testing, REMOVE this variable!**

---

## ✅ Verification Steps

1. **Check all variables are set** in Vercel
2. **Redeploy** after adding variables
3. **Test webhook** - should show "Succeeded" in Dodo Dashboard
4. **Check Vercel logs** for signature verification messages

---

**Last Updated**: 2024-01-22
