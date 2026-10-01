# Hydrilla Backend

Node.js/Express backend server for the Hydrilla 3D Generation Platform. Handles authentication, database operations, job management, and file uploads.

## Overview

This backend serves as the middleware between the frontend and the Python GPU server. It manages:
- User authentication via Clerk
- Job tracking and status synchronization
- Database operations (Supabase/PostgreSQL)
- Image uploads to S3
- Background job synchronization with Python API

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Clerk
- **Storage**: AWS S3
- **Deployment**: Vercel (Serverless Functions)

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
│   │   └── threeD.ts       # 3D generation API routes
│   ├── repository/
│   │   └── jobs.ts         # Database operations for jobs
│   ├── services/
│   │   ├── jobSync.ts      # Background job synchronization
│   │   └── email.ts        # Email service (ZeptoMail)
│   └── utils/
│       └── s3Urls.ts       # S3 URL normalization utilities
├── api/
│   └── index.ts            # Vercel serverless function entry
├── sql/
│   ├── schema.sql          # Database schema
│   └── add_job_name_migration.sql
├── uploads/                # Local file uploads (dev only)
├── package.json
├── tsconfig.json
├── vercel.json             # Vercel configuration
└── env.sample              # Environment variables template
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Supabase account and project
- Clerk account for authentication
- AWS account with S3 bucket
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
   ```bash
   # Run SQL schema in Supabase SQL editor
   cat sql/schema.sql
   ```

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

## Environment Variables

Create a `.env` file in the `backend/` directory with the following variables:

```env
# Server Configuration
PORT=4000

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Clerk Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Image generation (OpenAI / Gemini). Falls back to admin platform keys when unset.
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...

# GPU VM (BlueFox3D image-to-3d)
HYDRILLA_GPU_API_URL=https://api.hydrilla.co
HYDRILLA_INTERNAL_API_SECRET=must-match-the-vm

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
S3_PRESIGNED_URL_EXPIRY=3600

# Backend URL
BACKEND_URL=http://localhost:4000

# Job Sync Configuration
POLL_INTERVAL_MS=5000

# Email Configuration (Optional)
ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email
ZEPTOMAIL_TOKEN=Zoho-enczapikey YOUR_TOKEN
ZEPTOMAIL_FROM_ADDRESS=noreply@hydrilla.co
ZEPTOMAIL_FROM_NAME=Hydrilla
FRONTEND_URL=https://hydrilla.co
```

See `env.sample` for detailed descriptions.

## API Endpoints

All endpoints are prefixed with `/api/3d`

### Authentication Required Endpoints

See [`.env.example`](./.env.example) for the full list, including model overrides.

#### `POST /api/3d/text-to-image`
Generate an image with OpenAI or Gemini. Synchronous: the response contains the stored S3 image.

**Request Body:**
```json
{
  "prompt": "A red sports car, studio lighting",
  "provider": "openai",   // "openai" (default) | "gemini"
  "quality": "low",       // "low" (default, 2 credits) | "high" (5 credits)
  "aspect": "1:1",        // "1:1" (default) | "3:2" | "2:3"
  "chatId": "...", "workspaceId": "...", "parentJobId": "..."
}
```

**Response:**
```json
{
  "job_id": "uuid", "preview_id": "uuid", "status": "completed",
  "image_url": "https://<bucket>.s3.<region>.amazonaws.com/preview/<id>/preview_image.png",
  "provider": "openai", "quality": "low", "aspect": "1:1",
  "model": "gpt-image-2.5-flare", "credits_used": 2
}
```

#### `POST /api/3d/edit-image`
Edit an image with a prompt (multipart). Send either `image` (file) or `image_url`, plus `prompt`,
`provider`, `quality` (low = 3 credits, high = 6 credits). The output keeps the input's framing; `aspect` is ignored.
Stored at `edit/<id>/edited.png`; response uses `edit_id` instead of `preview_id`.

| Quality | OpenAI | Gemini |
|---|---|---|
| low | `gpt-image-2.5-flare`, quality `medium`, ~1K | `gemini-3.1-flash-image`, `1K` |
| high | `gpt-image-2.5-sunburst`, quality `high`, ~2K | `gemini-3-pro-image`, `2K` |

Credits are refunded if the provider fails. Moderation blocks return `422` with `code: "IMAGE_REQUEST_BLOCKED"`
and user-facing message `"This image request couldn't be generated. Try changing the prompt."`;
a missing key returns `503` with `code: "provider_not_configured"`.

#### `POST /api/3d/generate`
Create an image-to-3D job on the GPU VM (10 credits). Text-to-3D is text-to-image followed by this call.

**Request Body:**
```json
{
  "imageUrl": "https://example.com/image.jpg"
}
```

**Response:**
```json
{
  "jobId": "uuid-string"
}
```

#### `GET /api/3d/history`
Get all jobs for the authenticated user.

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

**Request Body:**
```json
{
  "name": "My Custom Name"
}
```

#### `DELETE /api/3d/jobs/:jobId`
Delete a job (only if you own it).

### Optional Authentication Endpoints

#### `GET /api/3d/status/:jobId`
Get job status (works without auth, but checks ownership if authenticated).

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

#### `POST /api/3d/upload-image`
Upload an image file to S3.

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

#### `GET /api/3d/queue/info`
Get current queue statistics.

#### `GET /api/3d/me`
Get current user profile and statistics.

#### `POST /api/3d/sync-user`
Sync authenticated user to database (called automatically).

### Chat Management Endpoints

#### `GET /api/3d/chats`
Get all chats for the authenticated user.

**Response:**
```json
{
  "chats": [
    {
      "id": "uuid",
      "name": "My Chat",
      "firstJobPreviewImageUrl": "https://s3.../preview.png",
      "firstJobPrompt": "A red sports car",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### `GET /api/3d/chats/active`
Get or create the most recently updated chat.

**Response:**
```json
{
  "chat": {
    "id": "uuid",
    "name": "New Chat",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

#### `GET /api/3d/chats/:chatId`
Get a specific chat with all its jobs.

**Response:**
```json
{
  "chat": {
    "id": "uuid",
    "name": "My Chat",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  },
  "jobs": [
    {
      "id": "uuid",
      "status": "DONE",
      "prompt": "A red sports car",
      "previewImageUrl": "https://s3.../preview.png",
      "resultGlbUrl": "https://s3.../mesh.glb"
    }
  ]
}
```

#### `POST /api/3d/chats`
Create a new chat.

**Request Body:**
```json
{
  "name": "My New Chat"  // Optional
}
```

#### `PATCH /api/3d/chats/:chatId/name`
Update chat name.

**Request Body:**
```json
{
  "name": "Updated Chat Name"
}
```

#### `DELETE /api/3d/chats/:chatId`
Delete a chat (only if you own it).

**Response:**
```json
{
  "success": true,
  "message": "Chat deleted"
}
```

### Health Check

#### `GET /api/health`
Check if server is running.

**Response:**
```json
{
  "ok": true
}
```

#### `GET /api/3d/health`
Feature availability. `text_to_image` / `edit_image` are true when an OpenAI or Gemini key is configured;
`image_to_3d` is true when the GPU VM reports its pipeline loaded.

```json
{
  "status": "ok",
  "features": { "text_to_image": true, "edit_image": true, "image_to_3d": true, "text_to_3d": true },
  "providers": { "openai": true, "gemini": true },
  "gpu": { "reachable": true, "ready": true, "status": "ok", "model": "BlueFox3D" }
}
```

## Job Status Mapping

| Backend Status | Python API Status | Description |
|----------------|-------------------|-------------|
| `WAIT` | `pending` | Job queued, waiting for GPU |
| `RUN` | `processing` | Job actively processing |
| `DONE` | `completed` | Job completed successfully |
| `FAIL` | `failed` / `cancelled` | Job failed or cancelled |

## Background Services

### Job Synchronization

The backend runs a background service that periodically syncs job status from the Python API:

- **Interval**: Configurable via `POLL_INTERVAL_MS` (default: 5000ms)
- **Function**: `syncAllJobs()` in `src/services/jobSync.ts`
- **Purpose**: Keeps database job status in sync with Python API

## Database Schema

See `sql/schema.sql` for the complete database schema. Key tables:

- **users**: User profiles synced from Clerk
- **jobs**: 3D generation jobs with status, URLs, and metadata
- **chats**: Chat conversations that group multiple jobs together (ChatGPT-like interface)

## Deployment

### Vercel Deployment

1. **Connect repository to Vercel**
2. **Set environment variables** in Vercel dashboard
3. **Deploy** - Vercel will automatically detect and deploy

### Manual Deployment

```bash
npm run build
# Deploy dist/ directory to your server
```

## Development

### Project Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server

### Code Structure

- **Routes**: Define API endpoints in `src/routes/`
- **Middleware**: Authentication and other middleware in `src/middleware/`
- **Repository**: Database operations in `src/repository/`
- **Services**: Background services in `src/services/`

### Logging

Uses Pino for structured logging. Logs are output in JSON format for easy parsing.

## Troubleshooting

### Database Connection Issues

- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
- Check Supabase project is active
- Verify network connectivity

### Authentication Errors

- Verify Clerk keys are correct
- Check token format in Authorization header
- Ensure Clerk webhook is configured (if using webhooks)

### S3 Upload Failures

- Verify AWS credentials are correct
- Check S3 bucket permissions
- Verify bucket name and region match

### Expired Image URLs

The backend automatically normalizes S3 image URLs to remove expired signed URL parameters. All image URLs returned from the API are converted to direct S3 URLs (without query parameters) to prevent expiration issues. This is handled in:

- `backend/src/utils/s3Urls.ts` - URL normalization utilities
- `backend/src/repository/jobs.ts` - Job data mapping
- `backend/src/repository/chats.ts` - Chat preview image normalization
- `backend/src/routes/threeD.ts` - API response normalization

If images are not showing, ensure:
1. S3 bucket is configured as public or has proper CORS settings
2. Image URLs in the database are being normalized correctly
3. Direct S3 URLs are being used instead of presigned URLs

### GPU VM Connection

- Verify `HYDRILLA_GPU_API_URL` is correct (`curl $HYDRILLA_GPU_API_URL/health`)
- Verify `HYDRILLA_INTERNAL_API_SECRET` matches the VM
- Check the `hydrilla-runtime` systemd service is running on the VM

### Image Generation

- `GET /api/3d/health` shows which providers have keys (`providers.openai` / `providers.gemini`)
- `npm run verify:images` checks request payloads against the provider docs (no network calls)

## Related Documentation

- **[BACKEND_GUIDE.md](./BACKEND_GUIDE.md)** - Complete backend guide (setup, API, payments, deployment)
- [API Documentation](../API_DOCUMENTATION.md) - Complete API reference
- [Environment Variables Guide](../ENVIRONMENT_VARIABLES.md) - Detailed env var guide
- [System Architecture](../SYSTEM_ARCHITECTURE.md) - System overview
- [Auth Setup Guide](../AUTH_SETUP_GUIDE.md) - Authentication setup

## License

Private - Hydrilla Platform
