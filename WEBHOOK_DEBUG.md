# Webhook Debugging Guide

## How to Test Webhook

### 1. Check Webhook is Receiving Events

Check your backend logs (Vercel Function Logs) for:
```
"Received Dodo Payment webhook"
```

### 2. Verify Webhook Payload Structure

The webhook payload should look like:
```json
{
  "business_id": "biz_...",
  "type": "payment.succeeded",
  "timestamp": "2025-01-13T18:00:00Z",
  "data": {
    "payload_type": "Payment",
    "payment_id": "pay_...",
    "customer": {
      "email": "customer@example.com",
      "name": "John Doe"
    },
    "total_amount": 199,
    "currency": "USD",
    ...
  }
}
```

### 3. Check Email Extraction

Look for logs like:
```
"Extracted payment data" with customerEmail, dodoPaymentId
```

### 4. Verify Database Record Creation

Check Supabase `early_access_payments` table:
```sql
SELECT * FROM early_access_payments 
ORDER BY created_at DESC 
LIMIT 10;
```

### 5. Check for Duplicate Prevention

If email already has completed payment, you'll see:
```
"Email already has a completed payment - duplicate prevented"
```

## Common Issues

### Issue: No records in database
**Solution**: 
- Check webhook is being received (check logs)
- Verify webhook secret is correct
- Check email extraction is working (see logs)

### Issue: Email not matching user
**Solution**:
- Ensure user email in `users` table matches payment email
- Check webhook logs for `matched_user: true/false`

### Issue: Duplicate payments
**Solution**:
- Check duplicate prevention is working
- Verify `payment_status = 'completed'` check

## Testing with Test Payment

1. Go to `https://dodo.pe/hydrilla`
2. Complete test payment
3. Check backend logs for webhook
4. Verify record in Supabase
