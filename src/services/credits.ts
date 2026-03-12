import { supabase } from "../db.js";
import { logger } from "../logger.js";

const FREE_TIER_CREDITS = 200;

/**
 * Get user_credits row for a user (by user_id only).
 */
export async function getCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  const row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("user_id", userId).maybeSingle()).data;
  return row ?? null;
}

/**
 * Ensure a user has a credits row. Creates free-tier (200 credits) if missing.
 * Returns the row (existing or newly created). Uses user_id only (no email).
 */
export async function ensureCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  let row = await getCreditsRow(userId);
  if (row) return row;

  logger.info({ userId }, "Creating free-tier credits row (200 credits)");
  const { data: newRow, error: insertErr } = await supabase
    .from("user_credits")
    .insert({
      user_id: userId,
      plan: null,
      credits_total: FREE_TIER_CREDITS,
      credits_used: 0,
    })
    .select("id, credits_used, credits_total, plan")
    .single();

  if (!insertErr && newRow) return newRow;

  if (insertErr?.code === "23505") {
    return getCreditsRow(userId);
  }

  logger.error({ error: insertErr, userId }, "Failed to create free-tier credits row");
  return null;
}

/**
 * Deduct credits for the user. Uses atomic RPC when available (scalable for high concurrency).
 * Returns { ok: true, remaining } or { ok: false, error }.
 */
export async function deductCredit(
  userId: string,
  amount: number = 1,
  requireCredits: boolean = true
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const row = await ensureCreditsRow(userId);

  if (!row) {
    if (requireCredits) return { ok: false, error: "No credit balance. Please subscribe to generate." };
    return { ok: true, remaining: 0 };
  }

  if (row.credits_total <= 0) {
    return { ok: false, error: "No credits remaining. Please subscribe or wait for renewal." };
  }

  const remainingBefore = row.credits_total - row.credits_used;
  if (remainingBefore < amount) {
    return { ok: false, error: `Insufficient credits. You have ${remainingBefore} left; ${amount} required.` };
  }

  // Prefer atomic RPC (run backend/sql/003_deduct_credits_function.sql in Supabase)
  const { data: rpcData, error: rpcError } = await supabase.rpc("deduct_user_credits", {
    p_credits_row_id: row.id,
    p_amount: amount,
  });

  if (!rpcError && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
    const first = rpcData[0] as { remaining: number; success: boolean };
    if (first.success) {
      logger.info({ userId, remaining: first.remaining }, "Credit deducted (atomic)");
      return { ok: true, remaining: first.remaining };
    }
    return { ok: false, error: `Insufficient credits. You have ${first.remaining} left; ${amount} required.` };
  }

  // Fallback: read-then-update (use when RPC is not deployed)
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
