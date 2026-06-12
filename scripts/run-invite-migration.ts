import dotenv from "dotenv";
import { runInviteAccessMigration } from "../src/services/inviteMigration.js";

dotenv.config();

async function main() {
  const ok = await runInviteAccessMigration();
  if (!ok) {
    console.error(
      "\nMigration failed. Set DATABASE_URL in backend/.env to your Supabase Postgres connection string,\n" +
        "or run backend/sql/migration_invite_access.sql manually in Supabase SQL Editor.\n"
    );
    process.exit(1);
  }
  console.log("Invite access migration completed.");
}

main();
