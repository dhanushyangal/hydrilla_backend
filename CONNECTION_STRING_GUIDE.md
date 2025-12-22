# How to Find Your Supabase Connection String

## Method 1: From the "Connect" Button (Easiest)

1. Go to your Supabase Dashboard: https://supabase.com/dashboard/project/qjkzhzoyhlcdqkmxzvry
2. Click the **"Connect"** button at the top right of the page
3. A modal will open showing connection options
4. Look for **"Connection string"** section
5. Click on the **"URI"** tab
6. Copy the connection string - it will look like:
   ```
   postgresql://postgres.qjkzhzoyhlcdqkmxzvry:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```
7. Replace `[YOUR-PASSWORD]` with: `Dhanush944038`

## Method 2: From Settings → Database

1. Go to: Settings → Database
2. Scroll down to find **"Connection string"** section
3. Click the **"URI"** tab
4. Copy the connection string

## Method 3: Manual Construction (If above don't work)

If you can't find the connection string, try these connection pooling formats:

**For Asia Pacific (Singapore):**
```
postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

**For Asia Pacific (Sydney):**
```
postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres
```

**For US East:**
```
postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

## Update Your .env File

Once you have the connection string, update `backend/.env`:

```env
DB_URL=postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

Replace `[REGION]` with your actual region from the connection string.

## Test Connection

After updating, restart your backend:
```bash
cd backend
npm run dev
```

You should see: `Database connection established`

