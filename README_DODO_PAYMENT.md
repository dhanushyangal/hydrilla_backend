# Dodo Payment Integration Guide

This guide explains how to set up and configure Dodo Payment for the Early Access feature.

## Environment Variables

Add these environment variables to your `.env` file (backend) and Vercel dashboard:

### Backend Environment Variables

```env
# Dodo Payment Configuration
DODO_PAYMENT_API_KEY=your_api_key_here
DODO_PAYMENT_MODE=test  # Use "test" for testing, "live" for production
DODO_PAYMENT_WEBHOOK_SECRET=your_webhook_secret_here
DODO_PAYMENT_PRODUCT_ID=your_early_access_product_id
```

**Note**: The base URL is automatically set based on `DODO_PAYMENT_MODE`:
- Test: `https://test.dodopayments.com`
- Live: `https://live.dodopayments.com`

## Where to Get These Values

### 1. API Key
- Log in to your Dodo Payment dashboard: [https://app.dodopayments.com](https://app.dodopayments.com)
- Navigate to **Developer** → **API Keys** (or [direct link](https://app.dodopayments.com/developer/api-keys))
- Click **"Add API Key"** or **"Create New API"**
- Give it a name (e.g., "Hydrilla Early Access")
- Copy the **API Key** (this is your only API credential - there is no separate secret key)

### 2. Product ID (Early Access Product)
**IMPORTANT**: You need to create a product in Dodo Payment dashboard first!

1. Go to **Products** in your Dodo Payment dashboard
2. Click **"Create Product"** or **"Add Product"**
3. Set up your Early Access product:
   - **Name**: "Hydrilla Early Access" (or similar)
   - **Price**: $59 per month (or your desired price)
   - **Type**: Subscription (recurring monthly) or One-time payment
   - **Description**: Early access to Hydrilla platform
4. Save the product
5. Copy the **Product ID** (starts with `prod_`)

**Note**: The product price is set in the dashboard, not in code. The API will use this product's pricing.

### 3. Webhook Secret
**✅ Webhook Already Created!**

The webhook has been created programmatically with:
- **Webhook ID**: `ep_38DJqRfmAjMx1NZL8K4flPAu7JQ`
- **URL**: `https://hydrilla-backend.vercel.app/api/payments/webhook/dodo`
- **Events**: `payment.succeeded`, `payment.failed`, `refund.succeeded`

**Webhook Secret**: `whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT`

**Add this to your environment variables as `DODO_PAYMENT_WEBHOOK_SECRET`**

> **Note**: You can also view/manage webhooks in the dashboard at [Developer → Webhooks](https://app.dodopayments.com/developer/webhooks)

## Quick Setup (Webhook Already Created)

✅ **Webhook has been created programmatically!**

- **Webhook ID**: `ep_38DJqRfmAjMx1NZL8K4flPAu7JQ`
- **Webhook Secret**: `whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT`

Add this secret to your environment variables:
```env
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
```

## Database Setup

Run the SQL migration to create the `early_access_payments` table:

```bash
# In Supabase SQL Editor, run:
cat sql/early_access_payments.sql
```

Or execute the SQL file directly in Supabase Dashboard → SQL Editor.

## Testing

### Test Mode Setup

1. Set `DODO_PAYMENT_MODE=test` in your environment variables
2. Use test API keys from Dodo Payment dashboard
3. Test the payment flow:
   - Visit `/earlyaccess` page
   - Enter an email
   - Click "Get Early Access"
   - Complete test payment using Dodo's test card numbers

### Test Card Numbers

Dodo Payment should provide test card numbers in their documentation. Common test cards:
- **Success**: Use the test card provided by Dodo
- **Failure**: Use an invalid card number

## Webhook Configuration

### Setting Up Webhook in Dodo Payment Dashboard

1. Go to **Settings** → **Webhooks** in Dodo Payment dashboard
2. Click **Add Webhook**
3. Set the webhook URL:
   ```
   https://your-backend.vercel.app/api/payments/webhook/dodo
   ```
4. Select events to listen for:
   - `payment.completed`
   - `payment.succeeded`
   - `payment.failed`
   - `payment.refunded`
5. Copy the **Webhook Secret** and add it to `DODO_PAYMENT_WEBHOOK_SECRET`

### Webhook Security

The webhook endpoint verifies the signature using HMAC SHA-256. Dodo Payment sends these headers:
- `webhook-id`: Unique identifier for the webhook event
- `webhook-signature`: HMAC SHA-256 signature
- `webhook-timestamp`: Timestamp of the webhook

Make sure:
- The webhook secret matches in both Dodo dashboard and your environment variables
- The webhook URL is accessible from the internet (not localhost)
- Your webhook endpoint accepts POST requests with JSON body

## Production Deployment

### Before Going Live

1. **Switch to Live Mode**:
   - Change `DODO_PAYMENT_MODE=live` in Vercel environment variables
   - Update to production API keys

2. **Update Webhook URL**:
   - Update webhook URL in Dodo Payment dashboard to production URL
   - Ensure webhook secret is updated

3. **Test with Real Payment**:
   - Make a small test payment ($1 if possible)
   - Verify webhook is received
   - Check database for payment record

4. **Monitor**:
   - Check backend logs for webhook events
   - Monitor payment status in database
   - Verify email notifications (if implemented)

## API Endpoints

### Create Checkout Session
```
POST /api/payments/early-access/create
Body: { "email": "user@example.com" }
Headers: Authorization: Bearer <token> (optional)

Response: {
  "paymentId": "uuid",
  "paymentLink": "https://checkout.dodopayments.com/...",
  "sessionId": "session_id",
  "status": "pending"
}
```

This endpoint:
1. Creates a payment record in the database
2. Creates a Dodo Payment checkout session via API
3. Returns the checkout URL for redirect

### Get Payment Status
```
GET /api/payments/early-access/:paymentId
Headers: Authorization: Bearer <token> (optional)
```

### Webhook Endpoint
```
POST /api/payments/webhook/dodo
Headers: 
  webhook-id: <webhook_id>
  webhook-signature: <signature>
  webhook-timestamp: <timestamp>
Body: <webhook event data>
```

The webhook handler:
- Verifies webhook signature for security
- Matches payments by payment_id, session_id, or email
- Updates payment status in database
- Links payments to user accounts when email matches
```

## How It Works

1. **User visits `/earlyaccess` page** and enters email
2. **Frontend calls** `POST /api/payments/early-access/create` with email
3. **Backend creates**:
   - Payment record in database (status: pending)
   - Checkout session via Dodo Payment API (`POST /checkouts`)
4. **Backend returns** checkout URL to frontend
5. **Frontend redirects** user to checkout URL
6. **User completes payment** on Dodo Payment hosted checkout
7. **Dodo Payment sends webhook** to `/api/payments/webhook/dodo`
8. **Backend updates** payment record (status: completed)
9. **User is redirected** back to `/earlyaccess?status=success`

## Troubleshooting

### Checkout Session Not Created
- Check API key is correct (only one key needed, no secret key)
- Verify `DODO_PAYMENT_PRODUCT_ID` is set and matches a product in your dashboard
- Ensure the product exists and is active in Dodo dashboard
- Check backend logs for API errors
- Verify you're using the correct mode (test vs live)
- Check that base URL is correct: `https://test.dodopayments.com` or `https://live.dodopayments.com`

### Webhook Not Received
- Verify webhook URL is accessible
- Check webhook secret matches
- Ensure webhook is enabled in Dodo dashboard
- Check Vercel function logs

### Payment Status Not Updating
- Verify webhook is being received (check logs)
- Check database connection
- Verify webhook signature validation
- Check payment record exists in database

## Support

For Dodo Payment specific issues:
- Check Dodo Payment documentation
- Contact Dodo Payment support
- Check Dodo Payment dashboard for transaction logs

For integration issues:
- Check backend logs in Vercel
- Verify all environment variables are set
- Test API endpoints manually
