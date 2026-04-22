# Hydrilla Backend - Complete Guide

Comprehensive guide for the Hydrilla Node.js/Express backend server. This document consolidates all setup, configuration, API documentation, payment integration, deployment, and troubleshooting information.

## Table of Contents

1. [Overview](#overview)
2. 
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Getting Started](#getting-started)
6. [Environment Variables](#environment-variables)
7. [API Endpoints](#api-endpoints)
8. [Payment Integration (Dodo Payments)](#payment-integration-dodo-payments)
9. [Database Schema](#database-schema)
10. [Deployment](#deployment)
11. [Troubleshooting](#troubleshooting)


---

## Overview


The Hydrilla backend serves as the middleware between the frontend and the Python GPU server. It manages:

- **User Authentication** via Clerk
- **Job Tracking** and status synchronization with Python API
- **Database Operations** (Supabase/PostgreSQL)
- **Image Uploads** to S3
- **Background Job Synchronization** with Python API
- **Payment Processing** via Dodo Payments (Early Access)

---

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Clerk
- **Storage**: AWS S3
- **Payment Processing**: Dodo Payments
- **Deployment**: Vercel (Serverless Functions)
- **Logging**: Pino

---

## Project Structure

```
backend/
├── src/
│   ├── server.ts           # Main server entry point
│   ├── config.ts           # Configuration management
│   ├── db.ts               # Database connection (Supabase)
│   ├── logger.ts           # Logging setup (Pino)
│   ├── types.ts            # TypeScript type definitions
│   ├── middleware/
│   │   └── auth.ts         # Authentication middleware (Clerk)
│   ├── routes/
│   │   ├── threeD.ts       # 3D generation API routes
│   │   └── payments.ts     # Payment processing routes
│   ├── repository/
│   │   └── jobs.ts          # Database operations for jobs
│   ├── services/
│   │   ├── jobSync.ts      # Background job synchronization
│   │   └── email.ts        # Email service (ZeptoMail)
│   └── utils/
│       └── s3Urls.ts        # S3 URL normalization utilities
├── api/
│   └── index.ts            # Vercel serverless function entry
├── sql/
│   ├── schema.sql          # Database schema
│   └── migrations/         # Database migrations
├── package.json
├── tsconfig.json
├── vercel.json             # Vercel configuration
└── .env                    # Environment variables (not committed)
```

---

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Supabase account and project
- Clerk account for authentication
- AWS account with S3 bucket
- Dodo Payments account (for payment processing)
- Python API server running (see main README)

### Installation

1. **Clone and navigate to backend directory:**
   ```bash
   cd backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp env.sample .env
   ```
   
   Edit `.env` with your credentials (see [Environment Variables](#environment-variables))

4. **Set up database:**
   - Go to Supabase Dashboard → SQL Editor
   - Run the SQL from `sql/schema.sql`
   - This creates all necessary tables and RLS policies

### Running Locally

**Development mode (with hot reload):**
```bash
npm run dev
```

**Production build:**
```bash
npm run build
npm start
```

Server will start on `http://localhost:4000`

---

## Environment Variables

### Complete Environment Variables List

Create a `.env` file in the `backend/` directory with the following variables:

#### Server Configuration
```env
PORT=4000
BACKEND_URL=http://localhost:4000
```

#### Supabase Configuration
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

#### Clerk Authentication
```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

#### Python API Configuration
```env
HUNYUAN_API_URL=https://api.hydrilla.co
```

#### AWS S3 Configuration
```env
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
S3_PRESIGNED_URL_EXPIRY=3600
```

#### Job Sync Configuration
```env
POLL_INTERVAL_MS=5000
```

#### Email Configuration (Optional)
```env
ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email
ZEPTOMAIL_TOKEN=Zoho-enczapikey YOUR_TOKEN
ZEPTOMAIL_FROM_ADDRESS=noreply@hydrilla.co
ZEPTOMAIL_FROM_NAME=Hydrilla
FRONTEND_URL=https://hydrilla.co
```

#### Dodo Payment Configuration
```env
# Dodo Payment API
DODO_PAYMENT_API_KEY=your_api_key_from_dodo_dashboard
DODO_PAYMENT_MODE=test  # Use "test" for testing, "live" for production
DODO_PAYMENT_PRODUCT_ID=pdt_your_product_id
DODO_PAYMENT_WEBHOOK_SECRET=whsec_wn3DwsRii+SZIgpj1r8yZh4IW/9rFOFT
DODO_PAYMENTS_RETURN_URL=http://localhost:3000/checkout/success

# Temporary: Skip webhook signature verification for testing (REMOVE IN PRODUCTION!)
# SKIP_WEBHOOK_VERIFICATION=true
```

### Vercel Environment Variables

When deploying to Vercel, set all the above variables in:
**Vercel Dashboard → Your Project → Settings → Environment Variables**

**Important for Production:**
- Set `DODO_PAYMENT_MODE=live` for production
- Set `FRONTEND_URL=https://hydrilla.co` (production URL)
- Set `DODO_PAYMENTS_RETURN_URL=https://hydrilla.co/checkout/success`
- **Remove** `SKIP_WEBHOOK_VERIFICATION` (or set to `false`)

### Getting Dodo Payment Credentials

1. **API Key:**
   - Go to: https://app.dodopayments.com/developer/api-keys
   - Create new API key or copy existing one
   - Use in: `DODO_PAYMENT_API_KEY`

2. **Product ID:**
   - Go to: https://app.dodopayments.com/products
   - Create a product for Early Access
   - Copy the product ID (starts with `pdt_`)
   - Use in: `DODO_PAYMENT_PRODUCT_ID`

3. **Webhook Secret:**
   - Go to: https://app.dodopayments.com/developer/webhooks
   - Find your webhook (or create one pointing to your backend)
   - Click "Signing Secret"
   - Copy the secret (starts with `whsec_`)
   - Use in: `DODO_PAYMENT_WEBHOOK_SECRET`

---

## API Endpoints

All endpoints are prefixed with `/api/3d` for 3D generation or `/api/payments` for payment processing.

### 3D Generation Endpoints

#### `POST /api/3d/generate`
Create a new 3D generation job.

**Auth**: Required

**Request Body:**
```json
{
  "prompt": "A red sports car"  // For text-to-3D
}
```
or
```json
{
  "imageUrl": "https://example.com/image.jpg"  // For image-to-3D
}
```

**Response:**
```json
{
  "jobId": "uuid-string"
}
```

#### `GET /api/3d/status/:jobId`
Get job status (works without auth, but checks ownership if authenticated).

**Auth**: Optional

**Response:**
```json
{
  "job": {
    "id": "uuid",
    "status": "WAIT" | "RUN" | "DONE" | "FAIL",
    "progress": 50,
    "resultGlbUrl": "https://s3.../mesh.glb",
    "previewImageUrl": "https://s3.../preview.png"
  },
  "queue": {
    "position": 1,
    "jobs_ahead": 1,
    "estimated_wait_seconds": 130
  }
}
```

#### `GET /api/3d/history`
Get all jobs for the authenticated user.

**Auth**: Required

**Response:**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "status": "DONE",
      "prompt": "A red sports car",
      "resultGlbUrl": "https://s3.../mesh.glb",
      "previewImageUrl": "https://s3.../preview.png",
      "name": "My 3D Model",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### `PATCH /api/3d/jobs/:jobId/name`
Update job name.

**Auth**: Required

**Request Body:**
```json
{
  "name": "My Custom Name"
}
```

#### `DELETE /api/3d/jobs/:jobId`
Delete a job (only if you own it).

**Auth**: Required

#### `POST /api/3d/upload-image`
Upload an image file to S3.

**Auth**: Optional

**Request:** `multipart/form-data` with `image` field

**Response:**
```json
{
  "success": true,
  "url": "https://s3.../uploads/image-123.jpg"
}
```

#### `POST /api/3d/register-job`
Register a job in the database (used internally when preview images are generated).

**Auth**: Optional

#### `GET /api/3d/queue/info`
Get current queue statistics.

**Auth**: Not required

#### `GET /api/3d/me`
Get current user profile and statistics.

**Auth**: Required

#### `POST /api/3d/sync-user`
Sync authenticated user to database (called automatically).

**Auth**: Required

### Payment Endpoints

#### `GET /api/payments/test`
Test endpoint to verify payments router is working.

**Response:**
```json
{
  "message": "Payments router is working",
  "config": {
    "hasApiKey": true,
    "hasProductId": true,
    "mode": "test"
  }
}
```

#### `GET /api/payments/early-access/check`
Check if a user/email has early access.

**Auth**: Optional

**Query Parameters:**
- `email` (optional): Email to check

**Response:**
```json
{
  "hasAccess": true,
  "accessInfo": {
    "id": "uuid",
    "email": "user@example.com",
    "status": "granted",
    "granted_at": "2024-01-01T00:00:00Z"
  }
}
```

#### `POST /api/payments/early-access/create`
Create a checkout session for early access payment.

**Auth**: Optional

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "paymentLink": "https://checkout.dodopayments.com/...",
  "sessionId": "session_id",
  "status": "checkout_created"
}
```

**Error Responses:**
- `409 Conflict`: User already has access
  ```json
  {
    "error": "ALREADY_HAS_ACCESS",
    "message": "This email already has early access"
  }
  ```

#### `GET /api/payments/early-access/:id`
Get early access information by ID.

**Auth**: Optional

#### `POST /api/payments/webhook/dodo`
Webhook endpoint for Dodo Payment events.

**Auth**: Not required (uses webhook signature verification)

**Headers:**
- `webhook-id`: Unique webhook event ID
- `webhook-signature`: HMAC signature
- `webhook-timestamp`: Timestamp

**Events Handled:**
- `payment.succeeded` / `payment.completed`: Grants early access
- `payment.failed`: Logs failed payment
- `refund.succeeded`: Revokes early access
- `refund.failed`: Logs failed refund

#### `GET /api/payments/refunds/:paymentId`
Get all refunds for a payment from Dodo API.

**Auth**: Optional

#### `POST /api/payments/sync-refund/:paymentId`
Manually sync refund status from Dodo API.

**Auth**: Optional

### Health Check

#### `GET /api/health`
Check if server is running.

**Response:**
```json
{
  "ok": true
}
```

---

## Payment Integration (Dodo Payments)

### Overview

The backend integrates with Dodo Payments for processing Early Access payments. The system includes:

- **Checkout Session Creation**: Creates secure checkout links
- **Webhook Processing**: Handles payment events asynchronously
- **Access Management**: Grants/revokes early access based on payment status
- **Duplicate Prevention**: Prevents multiple payments per email
- **Refund Handling**: Automatically revokes access on refund

### Payment Flow

1. **User clicks "Get Early Access"**
   - Frontend calls `POST /api/payments/early-access/create` with email
   - Backend checks if email already has access (prevents duplicates)
   - Backend creates checkout session via Dodo API
   - Returns checkout URL to frontend

2. **User completes payment on Dodo**
   - User redirected to Dodo Payment checkout
   - User enters payment details and completes payment
   - Dodo processes payment

3. **Webhook received**
   - Dodo sends webhook to `POST /api/payments/webhook/dodo`
   - Backend verifies webhook signature
   - Backend processes event asynchronously:
     - `payment.succeeded`: Grants early access in database
     - `refund.succeeded`: Revokes early access

4. **Access granted**
   - Early access record created in `early_access` table
   - User can now access the platform

### Webhook Security

The webhook endpoint uses HMAC SHA-256 signature verification:

1. **Extract headers**: `webhook-id`, `webhook-signature`, `webhook-timestamp`
2. **Verify signature**: Using Dodo Payments SDK
3. **Deduplication**: Check if webhook already processed (using `webhook_id`)
4. **Process event**: Handle payment/refund events

**Testing Mode:**
Set `SKIP_WEBHOOK_VERIFICATION=true` to bypass signature verification (testing only!)

### Database Tables

#### `early_access`
Stores early access grants:
- `id`: UUID (primary key)
- `email`: User email
- `user_id`: Clerk user ID (if logged in)
- `payment_id`: Dodo payment ID
- `status`: `granted` | `refunded`
- `amount`: Payment amount
- `granted_at`: When access was granted
- `metadata`: JSONB with payment data

#### `payment_attempts`
Logs all payment attempts:
- `id`: UUID
- `email`: User email
- `payment_id`: Dodo payment ID
- `status`: `pending` | `succeeded` | `failed` | `refunded`
- `amount_cents`: Payment amount in cents
- `webhook_id`: Webhook event ID (for deduplication)
- `metadata`: JSONB with payment data

#### `webhook_events`
Stores webhook events for deduplication:
- `id`: UUID
- `webhook_id`: Unique webhook event ID (unique constraint)
- `event_type`: Event type (e.g., `payment.succeeded`)
- `payload`: JSONB with full webhook data

### Troubleshooting Payments

#### Webhook Not Received
1. Check webhook URL in Dodo Dashboard
2. Verify webhook secret matches environment variable
3. Check Vercel function logs
4. Test webhook endpoint: `GET /api/payments/test`

#### Signature Verification Failing
1. Verify `DODO_PAYMENT_WEBHOOK_SECRET` is correct
2. Check webhook secret format (should start with `whsec_`)
3. Ensure raw body is used for signature verification
4. Check Vercel logs for verification errors

#### Payment Not Granting Access
1. Check webhook is being received (Vercel logs)
2. Verify `early_access` table exists and has correct schema
3. Check for duplicate email constraint errors
4. Verify payment status in Dodo Dashboard

#### Duplicate Payments
- System automatically prevents duplicates via:
  - Pre-checkout validation (checks if email has access)
  - Database unique constraint on email
  - Webhook deduplication (using `webhook_id`)

---

## Database Schema

See `sql/schema.sql` for the complete database schema. Key tables:

### `users`
User profiles synced from Clerk:
- `id`: Clerk user ID (primary key)
- `email`: User email
- `first_name`, `last_name`: User name
- `image_url`: Profile picture URL
- `created_at`, `updated_at`: Timestamps

### `jobs`
3D generation jobs:
- `id`: UUID (primary key)
- `user_id`: Foreign key to users table
- `status`: `WAIT` | `RUN` | `DONE` | `FAIL`
- `prompt`: Text prompt (for text-to-3d)
- `image_url`: Image URL (for image-to-3d)
- `result_glb_url`: Generated 3D model URL
- `preview_image_url`: Preview image URL
- `name`: User-defined job name
- `error_message`: Error message if failed
- `created_at`, `updated_at`: Timestamps

### `early_access`
Early access grants (see Payment Integration section)

### `payment_attempts`
Payment attempt logs (see Payment Integration section)

### `webhook_events`
Webhook event logs (see Payment Integration section)

### Row Level Security (RLS)

RLS policies ensure users can only access their own data:
- Users can only read/update/delete their own jobs
- Service role bypasses RLS for backend operations

---

## Deployment

### Vercel Deployment

1. **Connect repository to Vercel**
   - Go to Vercel Dashboard
   - Import your Git repository
   - Vercel will auto-detect Next.js/Node.js

2. **Set environment variables**
   - Go to Project Settings → Environment Variables
   - Add all variables from [Environment Variables](#environment-variables)
   - Set appropriate environment (Production, Preview, Development)

3. **Deploy**
   - Vercel will automatically deploy on push
   - Or manually trigger deployment from dashboard

4. **Configure Webhook URL**
   - Update Dodo Payment webhook URL to: `https://your-backend.vercel.app/api/payments/webhook/dodo`
   - Verify webhook secret matches

### Manual Deployment

```bash
npm run build
# Deploy dist/ directory to your server
```

### Post-Deployment Checklist

- [ ] Verify all environment variables are set in Vercel
- [ ] Test health endpoint: `GET /api/health`
- [ ] Test payments endpoint: `GET /api/payments/test`
- [ ] Verify webhook URL in Dodo Dashboard
- [ ] Test payment flow end-to-end
- [ ] Check Vercel function logs for errors

---

## Troubleshooting

### Database Connection Issues

- **Verify credentials**: Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- **Check Supabase project**: Ensure project is active
- **Verify network**: Check connectivity to Supabase
- **Check RLS policies**: Ensure service role can bypass RLS

### Authentication Errors

- **Verify Clerk keys**: Check `CLERK_SECRET_KEY` is correct
- **Check token format**: Ensure `Authorization: Bearer <token>` header
- **Verify token expiration**: Tokens expire after 1 hour
- **Check CORS**: Ensure frontend origin is allowed

### S3 Upload Failures

- **Verify AWS credentials**: Check `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- **Check S3 bucket permissions**: Ensure write permissions
- **Verify bucket name**: Check `S3_BUCKET` matches actual bucket
- **Check region**: Ensure `S3_REGION` matches bucket region

### Python API Connection

- **Verify API URL**: Check `HUNYUAN_API_URL` is correct
- **Check Python API is running**: Test with `curl https://api.hydrilla.co/health`
- **Verify CORS**: Ensure Python API allows backend origin
- **Check network**: Verify EC2 security group allows connections

### Payment Issues

See [Payment Integration - Troubleshooting](#troubleshooting-payments) section above.

### Build Errors

- **TypeScript errors**: Run `npm run build` locally to see errors
- **Missing dependencies**: Run `npm install`
- **Environment variables**: Ensure all required variables are set
- **Vercel build logs**: Check deployment logs in Vercel dashboard

---

## Development

### Project Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run lint` - Run linter (if configured)

### Code Structure

- **Routes**: Define API endpoints in `src/routes/`
- **Middleware**: Authentication and other middleware in `src/middleware/`
- **Repository**: Database operations in `src/repository/`
- **Services**: Background services in `src/services/`

### Logging

Uses Pino for structured logging. Logs are output in JSON format for easy parsing.

**Log Levels:**
- `error`: Errors that need attention
- `warn`: Warnings (e.g., missing optional data)
- `info`: General information (e.g., request received)
- `debug`: Debug information (development only)

---

## Related Documentation

- [API Documentation](../API_DOCUMENTATION.md) - Complete API reference
- [Environment Variables Guide](../ENVIRONMENT_VARIABLES.md) - Detailed env var guide
- [System Architecture](../SYSTEM_ARCHITECTURE.md) - System overview
- [Auth Setup Guide](../AUTH_SETUP_GUIDE.md) - Authentication setup

---

## License

Private - Hydrilla Platform
