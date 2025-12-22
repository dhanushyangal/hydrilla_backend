# How to Get Your Supabase Connection String

## Step-by-Step Instructions

### Method 1: Using the "Connect" Button (Easiest)

1. **Go to your Supabase Dashboard:**
   - Open: https://supabase.com/dashboard/project/qjkzhzoyhlcdqkmxzvry

2. **Click the "Connect" button:**
   - Look at the **top right** of the page
   - Click the green **"Connect"** button

3. **In the modal that opens:**
   - You'll see different connection options
   - Look for **"Connection string"** section
   - Click on the **"URI"** tab (not JDBC, not Golang)
   - You'll see something like:
     ```
     postgresql://postgres.qjkzhzoyhlcdqkmxzvry:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
     ```

4. **Copy the connection string:**
   - Replace `[YOUR-PASSWORD]` with: `Dhanush944038`
   - Copy the entire string

### Method 2: From Settings → Database

1. Go to: **Settings** → **Database** (left sidebar)
2. Scroll down to find **"Connection string"** section
3. Click the **"URI"** tab
4. Copy the connection string

### Method 3: If Connection String Section is Missing

If you don't see a "Connection string" section, try this:

1. **Check if your project is paused:**
   - Free tier projects can pause after inactivity
   - If paused, click "Resume" or "Restore"

2. **Use Connection Pooling format manually:**
   Try these (replace `[REGION]` with your region):
   
   **Singapore:**
   ```
   postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
   ```
   
   **Sydney:**
   ```
   postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres
   ```
   
   **US East:**
   ```
   postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

## Update Your .env File

Once you have the connection string:

1. Open `backend/.env` file
2. Update the `DB_URL` line:
   ```env
   DB_URL=postgresql://postgres.qjkzhzoyhlcdqkmxzvry:Dhanush944038@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```
3. **IMPORTANT:** Make sure there are NO spaces, NO newlines, and NO quotes around the connection string
4. Save the file

## Test the Connection

Run this command to test:
```bash
cd backend
npm run test-db
```

This will show you:
- ✅ If connection works
- ❌ If it fails, with detailed error message

## Common Issues

### Issue: "ENOTFOUND base" or "ENOTFOUND"
- **Cause:** Connection string is malformed or has newlines
- **Fix:** Make sure the entire connection string is on ONE line with NO spaces

### Issue: "Connection refused"
- **Cause:** Wrong port or hostname
- **Fix:** Use connection pooling format (port 6543) instead of direct (port 5432)

### Issue: "Password authentication failed"
- **Cause:** Wrong password
- **Fix:** Verify password is `Dhanush944038` (no special characters to encode)

## Still Can't Find It?

If you still can't find the connection string:
1. Take a screenshot of your Supabase Dashboard → Settings → Database page
2. Check if there's a "Connection string" section below "Connection pooling configuration"
3. Try clicking on different tabs (URI, JDBC, etc.)

