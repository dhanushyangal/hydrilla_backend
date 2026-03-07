# Dodo Payments – How It Works

This document describes how **Dodo Payments** is integrated for subscriptions, the request/response flow, and how the frontend connects to the backend.

---

## Overview

- **Provider:** [Dodo Payments](https://dodopayments.com) (hosted checkout, subscriptions, webhooks).
- **Plans:** **Creator** (1,000 credits/month) and **Studio** (4,000 credits/month).
- **Backend:** Node.js/Express in `src/routes/payments.ts`; config in `src/config.ts`; client in `src/lib/dodopayments.ts`.
- **Frontend:** Next.js app; checkout at `/checkout`, success at `/checkout/success`; credits/subscription shown in workspace and app sidebar.

---

## Backend Flow

### 1. Configuration (`src/config.ts`)

- **Mode:** `DODO_PAYMENT_MODE` = `"test"` or `"live"` (drives base URL and `environment` for the Dodo SDK).
- **Keys:** `DODO_PAYMENT_API_KEY`, `DODO_PAYMENT_WEBHOOK_SECRET`.
- **Products:** `DODO_PAYMENT_CREATOR_PRODUCT_ID`, `DODO_PAYMENT_STUDIO_PRODUCT_ID` (created in Dodo dashboard).
- **Return URL:** `DODO_PAYMENTS_RETURN_URL` = where Dodo redirects after payment (e.g. `https://yourdomain.com/checkout/success`).

The Dodo client (`src/lib/dodopayments.ts`) is created with:

- `bearerToken` = API key  
- `environment` = `test_mode` or `live_mode` from config  
- `webhookKey` = webhook secret (for verifying webhook signatures)

### 2. Create Checkout Session

**Endpoint:** `POST /api/payments/create-checkout`  
**Auth:** Optional (Clerk JWT); if present, `user_id` is stored in metadata and used to link subscription later.

**Request body:**

```json
{ "plan": "creator" | "studio", "email": "user@example.com" }
```

**Backend:**

1. Validates `plan` and `email`.
2. Resolves product ID from config (`creatorProductId` or `studioProductId`).
3. Builds `return_url` from `DODO_PAYMENTS_RETURN_URL` or `FRONTEND_URL + "/checkout/success"`.
4. Calls Dodo: `dodo.checkoutSessions.create({ product_cart, customer: { email }, return_url, metadata })`.
5. Logs the attempt in `payment_attempts` (optional).
6. Returns `{ checkoutUrl, sessionId }` to the frontend.

**Frontend:** Redirects the user to `checkoutUrl` (Dodo’s hosted checkout page).

### 3. User Pays on Dodo

- User completes payment on Dodo’s site.
- Dodo redirects to `return_url` with query params, e.g. `subscription_id`, `status`, and optionally `payment_id`.

### 4. Webhook (Subscription & Payment Events)

**Endpoint:** `POST /api/payments/webhook/dodo`  
**Body:** Raw JSON (must not be parsed by Express before the handler; server uses `express.raw({ type: "application/json" })` for this route).

**Headers (required):** `webhook-id`, `webhook-signature`, `webhook-timestamp` (used for signature verification and idempotency).

**Backend flow:**

1. **Deduplication:** Check `webhook_events` by `webhook_id`; if already processed, return `200` and skip.
2. **Verification:** Verify signature with `dodo.webhooks.unwrap(payload, { headers })` using `DODO_PAYMENT_WEBHOOK_SECRET`. (Can be skipped in dev with `SKIP_WEBHOOK_VERIFICATION=true`.)
3. **Store event:** Insert into `webhook_events` (webhook_id, event_type, payload).
4. **Handle event** (synchronously), then return `200` so Dodo does not retry:
   - `subscription.active` → create/update `user_subscriptions`, grant credits in `user_credits`.
   - `subscription.renewed` → reset credits for the new period.
   - `subscription.cancelled` / `subscription.expired` → mark subscription inactive; optionally zero or keep credits until period end.
   - `subscription.on_hold` / `subscription.failed` → update status.
   - `payment.succeeded` / `payment.failed` → record and optionally update state.
   - `credit.added` → apply one-off credit changes if used.
5. **Response:** Always `200` with `{ received: true, eventType }` so Dodo does not retry even if an internal handler fails (errors are only logged).

### 5. Sync (When Webhook Has Not Yet Fired)

**Endpoint:** `POST /api/payments/sync`  
**Query or body:** `payment_id=xxx` and/or `subscription_id=xxx`  
**Auth:** Optional; if present, `userId` is used to backfill `user_id` on the subscription/credits row.

Used when the user lands on the success page before the webhook has been delivered (e.g. slow network or localhost where webhook cannot reach the server).

**Backend:**

1. If only `payment_id` is given, fetches the payment from Dodo and resolves `subscription_id`.
2. Fetches the subscription from Dodo: `dodo.subscriptions.retrieve(subscription_id)`.
3. Calls the same logic as `subscription.active` (upsert `user_subscriptions`, grant/update credits in `user_credits`), so the DB matches what the webhook would do.

### 6. Get Subscription Status

**Endpoint:** `GET /api/payments/subscription`  
**Auth:** Required (Clerk JWT).

Returns the current active (or on_hold) subscription for the user: by `user_id`, or by `email` (from `users`) if no row by `user_id` exists. Response: `{ subscription: { ... } | null }`.

### 7. Get Credits

**Endpoint:** `GET /api/payments/credits`  
**Auth:** Required (Clerk JWT).

**Backend:**

1. Look up `user_credits` by `user_id`.
2. If not found, look up user’s `email` and try by `email`; if found, backfill `user_id`.
3. If still no row, create a free-tier row (e.g. 200 credits) and return it.
4. Response: `{ credits: { used, total, remaining, plan, resetAt } }`.

---

## Frontend Connection

### Environment

- **`NEXT_PUBLIC_BACKEND_URL`** – Base URL of this backend (e.g. `https://your-backend.vercel.app`). All payment and credit calls use this.

No Dodo keys or secrets are used in the frontend; everything goes through the backend.

### Pages & Components

| Place | What it does |
|-------|----------------|
| **`/checkout`** | Reads `?plan=creator|studio`, ensures user is signed in (Clerk), then calls `POST /api/payments/create-checkout` with `plan` and user email; redirects to `data.checkoutUrl` (Dodo hosted checkout). |
| **`/checkout/success`** | Reads `payment_id` and/or `subscription_id` from query. Calls `POST /api/payments/sync` with those IDs (so DB is updated even if webhook is delayed). Then polls `GET /api/payments/subscription` and `GET /api/payments/credits` until subscription is active and credits show; then redirects to Studio. |
| **Workspace** (`/workspace`) | Fetches `GET /api/payments/credits` to show remaining credits in the header and to gate generation (e.g. deduct 2 for image, 10 for 3D). |
| **App sidebar** | Fetches `GET /api/payments/credits` (credits card) and `GET /api/payments/subscription` (to show “Active” or upgrade CTA). |
| **App Usage** (`/app/usage`) | Fetches `GET /api/payments/credits` to show usage and link to “Manage plan” / “Buy credits”. |
| **Pricing section** | Static copy for Creator/Studio; “Get started” links to `/checkout?plan=creator` or `/checkout?plan=studio`. |

### Flow Summary (User Journey)

1. User chooses a plan (e.g. from Pricing or sidebar) → goes to `/checkout?plan=creator` (or `studio`).
2. Frontend calls `POST /api/payments/create-checkout` with plan + email → backend returns Dodo `checkoutUrl`.
3. User is redirected to Dodo → pays → Dodo redirects to `/checkout/success?subscription_id=...&status=active` (and optionally `payment_id=...`).
4. Success page calls `POST /api/payments/sync` with `subscription_id` (and `payment_id` if present) so the backend can create/update subscription and credits even before the webhook.
5. Success page polls `GET /api/payments/subscription` and `GET /api/payments/credits` until it sees an active subscription and updated credits, then redirects to Studio.
6. In parallel, Dodo sends a webhook to `POST /api/payments/webhook/dodo`; the backend stores the event and updates `user_subscriptions` and `user_credits` (idempotent with sync).
7. Workspace and sidebar always read credits and subscription from `GET /api/payments/credits` and `GET /api/payments/subscription`.

---

## Database Tables (Backend)

- **`user_subscriptions`** – One row per Dodo subscription; keyed by `dodo_subscription_id`; stores plan, status, period, `user_id`, `email`.
- **`user_credits`** – One row per user/email; stores `credits_total`, `credits_used`, `plan`, `reset_at`; updated by webhook/sync and when consuming credits (e.g. 3D job).
- **`webhook_events`** – Stores `webhook_id`, `event_type`, `payload` for idempotency and debugging.
- **`payment_attempts`** – Optional log of checkout session creation (email, plan, session_id, status).

---

## Environment Variables (Backend)

| Variable | Purpose |
|----------|---------|
| `DODO_PAYMENT_MODE` | `"test"` or `"live"` |
| `DODO_PAYMENT_API_KEY` | Dodo API key (test or live) |
| `DODO_PAYMENT_WEBHOOK_SECRET` | Webhook signing secret from Dodo |
| `DODO_PAYMENT_CREATOR_PRODUCT_ID` | Dodo product ID for Creator plan |
| `DODO_PAYMENT_STUDIO_PRODUCT_ID` | Dodo product ID for Studio plan |
| `DODO_PAYMENTS_RETURN_URL` | Full URL to redirect after payment (e.g. `https://yourdomain.com/checkout/success`) |
| `SKIP_WEBHOOK_VERIFICATION` | Optional; `"true"` only in dev when webhook cannot be verified |

Frontend only needs **`NEXT_PUBLIC_BACKEND_URL`** pointing at this backend.

---

## Quick Reference – API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/payments/test` | No | Config check (mode, product IDs present) |
| POST | `/api/payments/create-checkout` | Optional | Create Dodo checkout session; returns `checkoutUrl` |
| GET | `/api/payments/subscription` | Yes | Current user subscription |
| POST | `/api/payments/sync` | Optional | Sync subscription/credits from Dodo by `payment_id` or `subscription_id` |
| GET | `/api/payments/credits` | Yes | Current user credits (used, total, plan) |
| POST | `/api/payments/webhook/dodo` | No (verified by signature) | Dodo webhook for subscription/payment events |

All of the above are on the **backend**; the frontend calls them using `NEXT_PUBLIC_BACKEND_URL`.
