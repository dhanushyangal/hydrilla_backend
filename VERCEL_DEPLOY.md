# Deploy Backend to Vercel

This guide will help you deploy the backend API to Vercel as serverless functions.

## Prerequisites

1. Vercel account (sign up at https://vercel.com)
2. Git repository with your code
3. Environment variables ready

## Step 1: Install Vercel CLI (Optional)

```bash
npm install -g vercel
```

## Step 2: Navigate to Backend Directory

```bash
cd backend
```

## Step 3: Deploy via Vercel Dashboard (Recommended)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **"Add New Project"**
3. Import your Git repository
4. Configure the project:
   - **Root Directory**: `backend` (if your repo root is the project root)
   - **Framework Preset**: Other
   - **Build Command**: `npm run build`
   - **Output Directory**: Leave empty (we're using API routes)
   - **Install Command**: `npm install`

## Step 4: Set Environment Variables

In your Vercel project settings, go to **Settings → Environment Variables** and add:

```
PORT=4000
SUPABASE_URL=https://vyyzepmcqeqoxwjqnrxh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
HUNYUAN_API_URL=https://api.hydrilla.co
POLL_INTERVAL_MS=5000
BACKEND_URL=https://your-backend.vercel.app
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
```

**Important Notes:**
- `BACKEND_URL` should be your Vercel deployment URL (e.g., `https://your-project.vercel.app`)
- S3 credentials are **required** for file uploads on Vercel (can't use local storage)
- All environment variables are automatically available to your serverless functions

## Step 5: Deploy

Click **"Deploy"** and wait for the build to complete.

## Step 6: Update Frontend

After deployment, update your frontend's `NEXT_PUBLIC_BACKEND_URL` environment variable in Vercel to point to your backend URL:

```
NEXT_PUBLIC_BACKEND_URL=https://your-backend.vercel.app
```

## Alternative: Deploy via CLI

```bash
cd backend
vercel login
vercel --prod
```

Follow the prompts and set environment variables when asked.

## API Endpoints

After deployment, your API will be available at:
- Health: `https://your-backend.vercel.app/api/health`
- 3D Routes: `https://your-backend.vercel.app/api/3d/*`

## Important Notes for Vercel

1. **File Uploads**: Must use S3 (local storage not available on Vercel)
2. **Background Jobs**: The background job sync service won't run automatically. You'll need to:
   - Use Vercel Cron Jobs (Pro plan) for scheduled tasks
   - Or trigger sync via API endpoints
   - Or use an external cron service
3. **Cold Starts**: First request may be slower due to serverless cold starts
4. **Function Timeout**: Default timeout is 10 seconds (60 seconds on Pro plan)

## Testing

```bash
# Health check
curl https://your-backend.vercel.app/api/health

# Should return: {"ok":true}
```

## Troubleshooting

### Build Fails
- Check Vercel build logs
- Ensure all dependencies are in `package.json`
- Verify TypeScript compilation succeeds locally

### Environment Variables Not Working
- Make sure variables are set in Vercel dashboard
- Redeploy after adding new variables
- Check variable names match exactly (case-sensitive)

### File Upload Fails
- Verify S3 credentials are correct
- Check S3 bucket permissions
- Ensure S3 bucket exists and is accessible

### Database Connection Fails
- Verify Supabase credentials
- Check if your Supabase project allows connections from Vercel IPs
- Test connection locally first

## Monitoring

- View logs in Vercel Dashboard → Your Project → Logs
- Check function invocations and errors
- Monitor function execution time

## Next Steps

1. Set up custom domain
2. Configure Vercel Cron Jobs for background sync (if needed)
3. Set up monitoring and alerts
4. Optimize cold start times

