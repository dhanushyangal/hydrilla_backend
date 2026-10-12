# Hydrilla Backend

Express + TypeScript API for Hydrilla — auth, jobs, credits, payments, support, admin, blog, Water, and public claim links.

Lives at `hydrilla/backend` (sibling of `frontend/` and `admin/`).

**Full guide:** [`BACKEND_GUIDE.md`](./BACKEND_GUIDE.md) · **Water deploy:** [`WATER_DEPLOY.md`](./WATER_DEPLOY.md) · **Payments:** [`DODO_PAYMENTS.md`](./DODO_PAYMENTS.md)

## Overview

- Clerk auth middleware
- Cloud 3D jobs + background sync with the GPU API
- Credits, subscriptions (Dodo), and admin credit grants / claim links
- Support & feedback tickets (+ S3 uploads)
- Water / code-sculpt BYOK flows
- Blog CMS APIs for the admin app
- Developer API under `/v1` and `/api/v1`

## Tech stack

Node.js · Express · TypeScript · Supabase (PostgreSQL) · Clerk · AWS S3 · ZeptoMail · Vercel (`api/index.ts`)

## Project structure

```text
backend/
├── src/
│   ├── server.ts              # Local Express entry
│   ├── config.ts / db.ts
│   ├── routes/                # API routers (see below)
│   ├── repository/            # DB access
│   ├── services/              # jobSync, email, credits, …
│   └── middleware/auth.ts
├── api/index.ts               # Vercel serverless entry
├── sql/                       # Numbered migrations + schema.sql
├── package.json
└── vercel.json
```

## Getting started

```bash
cd hydrilla/backend
npm install
cp .env.example .env   # or copy from your secrets store
npm run dev            # default :4000 + background job sync
```

Prerequisites: Node 18+, Supabase project, Clerk, S3 (or local uploads in dev), GPU API URL for cloud jobs.

Apply SQL migrations in order under `sql/` (including recent ones such as `018_support_feedback.sql` and `024_credit_ledger_and_claims.sql`) in the Supabase SQL editor before relying on support or claim-credits features.

## Main API mounts

| Mount | Purpose |
|-------|---------|
| `GET /api/health` | Health check |
| `/api/3d` | Cloud 3D jobs |
| `/api/payments`, `/api/dodo` | Billing + webhooks |
| `/api/support` | Public support / feedback submit + upload |
| `/api/user` | Current user profile / credits |
| `/api/credits/claim` | Public claim-token redeem |
| `/api/admin` | Admin (users, usage, GPU, blog, support, credit claims, …) |
| `/api/blog` | Public blog |
| `/api/water`, `/api/code-sculpt` | Water / procedural generation |
| `/api/create/tools` | Create orchestration tools |
| `/v1`, `/api/v1` | Developer API |

## Related apps

| App | Dir | Port (dev) |
|-----|-----|------------|
| Frontend | `../frontend` | 3000 |
| Admin | `../admin` | 3001 |

CORS origins are configured via env (`config.corsOrigins`) — include `http://localhost:3000` and `http://localhost:3001` for local work.

## Deployment

Vercel project from this folder. Local `npm run dev` runs background `syncAllJobs`; serverless relies on request-driven / `waitUntil` patterns for long work.

## License

Private — Hydrilla Platform
