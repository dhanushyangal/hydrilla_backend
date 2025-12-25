# Quick Vercel Backend Deployment

## 5-Minute Setup

### Step 1: Deploy via Vercel Dashboard

1. Go to https://vercel.com/dashboard
2. Click **"Add New Project"**
3. Import your Git repository
4. Configure:
   - **Root Directory**: `backend`
   - **Framework Preset**: Other
   - **Build Command**: Leave default (or `npm run build`)
   - **Output Directory**: Leave empty
   - **Install Command**: `npm install`

### Step 2: Add Environment Variables

In **Settings → Environment Variables**, add:

```
SUPABASE_URL=https://vyyzepmcqeqoxwjqnrxh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key-here
HUNYUAN_API_URL=https://api.hydrilla.co
BACKEND_URL=https://your-project.vercel.app
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_BUCKET=hunyuan3d-outputs
S3_REGION=us-east-1
```

### Step 3: Deploy

Click **Deploy** and wait for completion.

### Step 4: Update Frontend

In your frontend Vercel project, update:
```
NEXT_PUBLIC_BACKEND_URL=https://your-backend.vercel.app
```

## Test

```bash
curl https://your-backend.vercel.app/api/health
# Should return: {"ok":true}
```

## Done! 🎉

Your backend API is now live on Vercel!







