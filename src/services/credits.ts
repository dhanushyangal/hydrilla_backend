import { supabase } from "../db.js";
import { logger } from "../logger.js";

const FREE_TIER_CREDITS = 200;

/**
 * Get user_credits row for a user.
 * Checks by user_id first, then falls back to email lookup and backfills user_id.
 */
export async function getCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  // 1. By user_id
  let row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("user_id", userId).maybeSingle()).data;
  if (row) return row;

  // 2. By email (handles rows created with user_id=null by webhook)
  const { data: user } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
  if (!user?.email) return null;

  row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("email", user.email).maybeSingle()).data;
  if (row) {
    // Backfill user_id so future lookups hit the fast path
    await supabase
      .from("user_credits")
      .update({ user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  return row;
}

/**
 * Ensure a user has a credits row. Creates free-tier (200 credits) if missing.
 * Returns the row (existing or newly created).
 */
export async function ensureCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  let row = await getCreditsRow(userId);
  if (row) return row;

  // Create free-tier row
  const { data: user } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
  if (!user?.email) return null;

  logger.info({ userId, email: user.email }, "Creating free-tier credits row (200 credits)");
  const { data: newRow, error: insertErr } = await supabase
    .from("user_credits")
    .insert({
      user_id: userId,
      email: user.email,
      plan: null,
      credits_total: FREE_TIER_CREDITS,
      credits_used: 0,
    })
    .select("id, credits_used, credits_total, plan")
    .single();

  if (!insertErr && newRow) return newRow;

  if (insertErr?.code === "23505") {
    // Race condition – just fetch it
    return getCreditsRow(userId);
  }

  logger.error({ error: insertErr, userId }, "Failed to create free-tier credits row");
  return null;
}

/**
 * Deduct credits for the user. Returns { ok: true, remaining } or { ok: false, error }.
 * Free-tier users (200 credits) can also generate; pass requireCredits=false to allow zero-balance.
 */
export async function deductCredit(
  userId: string,
  amount: number = 1,
  requireCredits: boolean = true
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  // Ensure row exists (auto-creates free tier if needed)
  const row = await ensureCreditsRow(userId);

  if (!row) {
    if (requireCredits) return { ok: false, error: "No credit balance. Please subscribe to generate." };
    return { ok: true, remaining: 0 };
  }

  if (row.credits_total <= 0) {
    return { ok: false, error: "No credits remaining. Please subscribe or wait for renewal." };
  }

  const remaining = row.credits_total - row.credits_used;
  if (remaining < amount) {
    return { ok: false, error: `Insufficient credits. You have ${remaining} left; ${amount} required.` };
  }

  const newUsed = row.credits_used + amount;
  const { error } = await supabase
    .from("user_credits")
    .update({
      credits_used: newUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (error) {
    logger.error({ error, userId, id: row.id }, "Failed to deduct credit");
    return { ok: false, error: "Failed to update credits." };
  }

  logger.info({ userId, newUsed, total: row.credits_total, remaining: row.credits_total - newUsed }, "Credit deducted");
  return { ok: true, remaining: row.credits_total - newUsed };
}
