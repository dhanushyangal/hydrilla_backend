# Early Access Payment Flow - Complete Explanation

## ✅ Yes, Everything is Stored in Supabase!

All payment data is stored in the `early_access_payments` table in your Supabase database.

---

## 📊 Database Schema

### Table: `early_access_payments`

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | UUID | Unique payment record ID (our internal ID) | `550e8400-e29b-41d4-a716-446655440000` |
| `user_id` | TEXT | Clerk user ID (if user is logged in) | `user_2abc123...` |
| `email` | TEXT | Customer email address | `customer@example.com` |
| `payment_id` | TEXT | Dodo Payment transaction ID | `pay_xyz789...` |
| `payment_status` | VARCHAR | Payment status | `pending`, `completed`, `failed`, `refunded` |
| `amount` | DECIMAL | Payment amount in USD | `1.99` |
| `currency` | VARCHAR | Currency code | `USD` |
| `dodo_payment_link` | TEXT | Payment link used | `https://dodo.pe/hydrilla` |
| `metadata` | JSONB | Additional payment data from Dodo | `{ "checkout_type": "direct_link", ... }` |
| `created_at` | TIMESTAMPTZ | When record was created | `2025-01-13T18:00:00Z` |
| `updated_at` | TIMESTAMPTZ | Last update timestamp | `2025-01-13T18:05:00Z` |

---

## 🔄 Complete Payment Flow

### Step 1: User Clicks "Get Early Access"
```
User enters email → Clicks "Get Early Access" button
```

### Step 2: Frontend Calls Backend API
```
POST /api/payments/early-access/create
Body: { "email": "customer@example.com" }
```

### Step 3: Backend Creates Payment Record in Supabase
**What gets stored:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",  // Generated UUID
  "user_id": "user_2abc123..." (if logged in, else null),
  "email": "customer@example.com",
  "payment_status": "pending",
  "amount": 0,  // Will be updated by webhook
  "currency": "USD",
  "dodo_payment_link": "https://dodo.pe/hydrilla",
  "metadata": {
    "checkout_type": "direct_link",
    "product": "early_access"
  },
  "created_at": "2025-01-13T18:00:00Z",
  "updated_at": "2025-01-13T18:00:00Z"
}
```

**Note:** At this point, `payment_id` is NULL (will be filled by webhook)

### Step 4: User Redirected to Dodo Payment
```
Frontend redirects to: https://dodo.pe/hydrilla
User completes payment on Dodo Payment checkout page
```

### Step 5: Dodo Payment Processes Payment
- User enters payment details
- Payment is processed
- Dodo Payment sends webhook to your backend

### Step 6: Webhook Received (Payment Success)
```
POST /api/payments/webhook/dodo
Headers: 
  - webhook-id: ep_38DJqRfmAjMx1NZL8K4flPAu7JQ
  - webhook-signature: v1=abc123...
  - webhook-timestamp: 1234567890

Body: {
  "event_type": "payment.succeeded",
  "data": {
    "payment_id": "pay_xyz789...",  // Dodo Payment transaction ID
    "total_amount": 199,  // Amount in cents ($1.99)
    "currency": "USD",
    "customer": {
      "email": "customer@example.com"
    },
    "metadata": {
      "payment_id": "550e8400-e29b-41d4-a716-446655440000"  // Our internal ID
    }
  }
}
```

### Step 7: Backend Updates Database
**What gets updated:**
```json
{
  "payment_id": "pay_xyz789...",  // ✅ Now filled with Dodo Payment ID
  "payment_status": "completed",  // ✅ Changed from "pending"
  "amount": 1.99,  // ✅ Updated from 0
  "metadata": {  // ✅ Full webhook data stored
    "checkout_type": "direct_link",
    "product": "early_access",
    "dodo_payment_data": { ... }  // Complete webhook payload
  },
  "updated_at": "2025-01-13T18:05:00Z"  // ✅ Updated timestamp
}
```

---

## 📝 What Gets Stored at Each Stage

### Initial Record (Step 3)
- ✅ User email
- ✅ User ID (if logged in)
- ✅ Payment status: `pending`
- ✅ Payment link: `https://dodo.pe/hydrilla`
- ✅ Created timestamp
- ❌ Payment ID (Dodo): Not yet available
- ❌ Amount: Set to 0 (will be updated)

### After Webhook (Step 7)
- ✅ **Everything from initial record**
- ✅ **Payment ID (Dodo)**: `pay_xyz789...`
- ✅ **Payment status**: `completed` / `failed` / `refunded`
- ✅ **Amount**: Actual payment amount (e.g., `1.99`)
- ✅ **Full webhook data**: Stored in `metadata` JSONB field

---

## 🔍 How to Query the Database

### Get all completed payments:
```sql
SELECT * FROM early_access_payments 
WHERE payment_status = 'completed'
ORDER BY created_at DESC;
```

### Get payments by email:
```sql
SELECT * FROM early_access_payments 
WHERE email = 'customer@example.com';
```

### Get payments by user:
```sql
SELECT * FROM early_access_payments 
WHERE user_id = 'user_2abc123...';
```

### Get payment by Dodo Payment ID:
```sql
SELECT * FROM early_access_payments 
WHERE payment_id = 'pay_xyz789...';
```

---

## 🛡️ Security Features

1. **Webhook Signature Verification**: All webhooks are verified using HMAC SHA-256
2. **Row Level Security (RLS)**: Users can only see their own payments
3. **Email Validation**: Email format is validated before creating record
4. **Duplicate Prevention**: Checks for existing completed payments by email/user

---

## 🔄 Payment Status Flow

```
pending → completed ✅
pending → failed ❌
completed → refunded ↩️
```

---

## 📧 What Happens After Payment

Currently implemented:
- ✅ Payment record created in database
- ✅ Payment status updated via webhook
- ✅ Full payment data stored in metadata

Future enhancements (TODO):
- 📧 Send confirmation email
- 🎁 Grant early access to platform
- 📊 Analytics and reporting
- 🔔 Notifications

---

## 🐛 Troubleshooting

### Payment not showing as completed?
1. Check webhook logs in backend
2. Verify webhook secret is correct
3. Check if webhook is being received: `POST /api/payments/webhook/dodo`
4. Verify `metadata.payment_id` matches your database record ID

### Can't find payment in database?
1. Check by email: `SELECT * FROM early_access_payments WHERE email = '...'`
2. Check by user_id: `SELECT * FROM early_access_payments WHERE user_id = '...'`
3. Check all pending: `SELECT * FROM early_access_payments WHERE payment_status = 'pending'`

---

## 📊 Example Complete Record

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "user_2abc123def456",
  "email": "customer@example.com",
  "payment_id": "pay_xyz789abc123",
  "payment_status": "completed",
  "amount": 1.99,
  "currency": "USD",
  "dodo_payment_link": "https://dodo.pe/hydrilla",
  "metadata": {
    "checkout_type": "direct_link",
    "product": "early_access",
    "dodo_payment_data": {
      "payment_id": "pay_xyz789abc123",
      "total_amount": 199,
      "currency": "USD",
      "status": "succeeded",
      "customer": {
        "email": "customer@example.com",
        "name": "John Doe"
      },
      "created_at": "2025-01-13T18:05:00Z"
    }
  },
  "created_at": "2025-01-13T18:00:00Z",
  "updated_at": "2025-01-13T18:05:00Z"
}
```

---

## ✅ Summary

**Yes, everything is stored in Supabase!**

- ✅ Initial payment record created when user clicks "Get Early Access"
- ✅ Payment status updated via webhook when payment completes
- ✅ Full payment data stored in `metadata` JSONB field
- ✅ All timestamps tracked (`created_at`, `updated_at`)
- ✅ Can query by email, user_id, payment_id, or status
- ✅ Secure with webhook signature verification and RLS
