import fs from "fs";
import path from "path";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pg;

export async function runInviteAccessMigration(): Promise<boolean> {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — skipping auto invite migration");
    return false;
  }

  const sqlPath = path.join(process.cwd(), "sql", "migration_invite_access.sql");
  if (!fs.existsSync(sqlPath)) {
    logger.error({ sqlPath }, "Invite migration SQL file not found");
    return false;
  }

  const sql = fs.readFileSync(sqlPath, "utf8");
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await pool.query(sql);
    logger.info("Invite access migration applied successfully");
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, "Invite access migration failed");
    return false;
  } finally {
    await pool.end();
  }
}

export async function ensureInviteAccessSchema(): Promise<void> {
  const { supabase } = await import("../db.js");
  const { error } = await supabase.from("invite_tokens").select("id").limit(1);

  if (!error) return;

  if (error.code !== "PGRST205") {
    logger.warn({ err: error }, "Could not verify invite_tokens table");
    return;
  }

  logger.warn("invite_tokens table missing — attempting migration...");
  const applied = await runInviteAccessMigration();
  if (!applied) {
    logger.warn(
      "Invite tables still missing. Run backend/sql/migration_invite_access.sql in Supabase SQL Editor."
    );
  }
}
