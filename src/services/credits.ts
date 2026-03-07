import { supabase } from "../db.js";
import { logger } from "../logger.js";

/**
 * Get user_credits row for a user (by user_id, or by email if row was created with user_id null).
 */
export async function getCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  let row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("user_id", userId).maybeSingle()).data;
  if (row) return row;
  const { data: user } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
  if (!user?.email) return null;
  row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("email", user.email).maybeSingle()).data;
  return row;
}

/**
 * Deduct one credit for the user. Returns { ok: true, remaining } or { ok: false, error }.
 * If user has no credits row or total is 0, allows the request (no deduction) for backward compatibility;
 * set requireCredits: true to enforce that they must have a paid plan.
 */
export async function deductCredit(
  userId: string,
  amount: number = 1,
  requireCredits: boolean = true
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const row = await getCreditsRow(userId);
  if (!row) {
    if (requireCredits) return { ok: false, error: "No credit balance. Please subscribe to generate." };
    return { ok: true, remaining: 0 };
  }
  if (row.credits_total <= 0) {
    if (requireCredits) return { ok: false, error: "No credits remaining. Please upgrade or wait for renewal." };
    return { ok: true, remaining: 0 };
  }
  const newUsed = row.credits_used + amount;
  if (newUsed > row.credits_total) {
    return { ok: false, error: `Insufficient credits. You have ${row.credits_total - row.credits_used} left; 1 required.` };
  }

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
  return { ok: true, remaining: row.credits_total - newUsed };
}
