import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// Create Supabase client with service_role key (bypasses RLS)
export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export async function initDb() {
  if (!config.supabase.serviceRoleKey) {
    logger.warn("SUPABASE_SERVICE_ROLE_KEY is not set. Database operations will fail.");
    return;
  }
  try {
    // Test connection by querying the jobs table
    const { error } = await supabase.from("jobs").select("id").limit(1);
    if (error) {
      // PGRST205 or PGRST116 means table doesn't exist - this is expected on first run
      if (error.code === "PGRST205" || error.code === "PGRST116") {
        logger.warn(
          "The 'jobs' table does not exist yet. Please create it using the SQL in backend/sql/schema.sql"
        );
        logger.warn("Go to Supabase Dashboard → SQL Editor → Run the schema.sql file");
        // Don't throw - allow the app to start, but operations will fail until table is created
        return;
      }
      // Other errors are real connection issues
      throw error;
    }
    logger.info("Database connection established");
  } catch (err: any) {
    logger.error(err, "Failed to connect to database");
    throw new Error(`Database connection failed: ${err.message}`);
  }
}

