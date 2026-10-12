import { supabase } from "../db.js";
import { logger } from "../logger.js";

const FREE_TIER_CREDITS = 100;

/**
 * Get user_credits row for a user (by user_id only).
 */
export async function getCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  const row = (await supabase.from("user_credits").select("id, credits_used, credits_total, plan").eq("user_id", userId).maybeSingle()).data;
  return row ?? null;
}

/**
 * Ensure a user has a credits row. Creates free-tier (100 credits) if missing.
 * Returns the row (existing or newly created). Uses user_id only (no email).
 */
export async function ensureCreditsRow(userId: string): Promise<{ id: string; credits_used: number; credits_total: number; plan: string | null } | null> {
  const row = await getCreditsRow(userId);
  if (row) {
    return row;
  }

  logger.info({ userId }, "Creating free-tier credits row (100 credits)");
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

  if (!insertErr && newRow) {
    return newRow;
  }

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
    if (requireCredits) {
      return { ok: false, error: "No credit balance. Please subscribe to generate." };
    }
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

/** Give back credits charged for an operation that failed upstream. Never drops credits_used below 0. */
export async function refundCredit(userId: string, amount: number): Promise<void> {
  if (amount <= 0) {
    return;
  }
  const row = await getCreditsRow(userId);
  if (!row) {
    return;
  }

  // Prefer atomic RPC (run backend/sql/017_refund_user_credits_function.sql in Supabase)
  const { data: rpcData, error: rpcError } = await supabase.rpc("refund_user_credits", {
    p_credits_row_id: row.id,
    p_amount: amount,
  });

  if (!rpcError && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
    const first = rpcData[0] as { remaining: number; success: boolean };
    if (first.success) {
      logger.info({ userId, amount, remaining: first.remaining }, "Credits refunded (atomic)");
      return;
    }
  }

  const newUsed = Math.max(0, row.credits_used - amount);
  const { error } = await supabase
    .from("user_credits")
    .update({ credits_used: newUsed, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (error) {
    logger.error({ error, userId, amount }, "Failed to refund credits");
    return;
  }
  logger.info({ userId, amount, newUsed }, "Credits refunded");
}

export interface CreditLedgerRow {
  id: string;
  user_id: string;
  delta: number;
  balance_total_after: number;
  balance_used_after: number;
  source: "admin_grant" | "admin_remove" | "claim_link" | "system";
  reason: string | null;
  admin_user_id: string | null;
  admin_email: string | null;
  claim_link_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface GrantCreditsOptions {
  reason?: string;
  adminUserId?: string;
  adminEmail?: string;
  source?: "admin_grant" | "claim_link" | "system";
  claimLinkId?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoveCreditsOptions {
  reason?: string;
  adminUserId?: string;
  adminEmail?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Grant credits to a user, incrementing credits_total and logging to credit_ledger.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  meta: GrantCreditsOptions = {}
): Promise<{ ok: true; remaining: number; total: number; used: number } | { ok: false; error: string }> {
  if (amount <= 0) {
    return { ok: false, error: "Grant amount must be greater than zero." };
  }

  const row = await ensureCreditsRow(userId);
  if (!row) {
    return { ok: false, error: "Failed to load user credits row." };
  }

  const newTotal = row.credits_total + amount;
  const { error: updateErr } = await supabase
    .from("user_credits")
    .update({
      credits_total: newTotal,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateErr) {
    logger.error({ error: updateErr, userId }, "Failed to update user_credits on grant");
    return { ok: false, error: updateErr.message || "Failed to update user credits." };
  }

  const { error: ledgerErr } = await supabase
    .from("credit_ledger")
    .insert({
      user_id: userId,
      delta: amount,
      balance_total_after: newTotal,
      balance_used_after: row.credits_used,
      source: meta.source || "admin_grant",
      reason: meta.reason || null,
      admin_user_id: meta.adminUserId || null,
      admin_email: meta.adminEmail || null,
      claim_link_id: meta.claimLinkId || null,
      metadata: meta.metadata || {},
    });

  if (ledgerErr) {
    logger.warn({ error: ledgerErr, userId }, "[Credits] Failed to record credit_ledger row");
  }

  const remaining = Math.max(0, newTotal - row.credits_used);
  return {
    ok: true,
    remaining,
    total: newTotal,
    used: row.credits_used,
  };
}

/**
 * Deduct credits from a user's total balance, never letting total drop below used.
 */
export async function removeCredits(
  userId: string,
  amount: number,
  meta: RemoveCreditsOptions = {}
): Promise<{ ok: true; remaining: number; total: number; used: number; removed: number } | { ok: false; error: string }> {
  if (amount <= 0) {
    return { ok: false, error: "Remove amount must be greater than zero." };
  }

  const row = await ensureCreditsRow(userId);
  if (!row) {
    return { ok: false, error: "Failed to load user credits row." };
  }

  const newTotal = Math.max(row.credits_used, row.credits_total - amount);
  const actualRemoved = row.credits_total - newTotal;

  if (actualRemoved <= 0) {
    return { ok: false, error: "Cannot remove credits below used balance." };
  }

  const { error: updateErr } = await supabase
    .from("user_credits")
    .update({
      credits_total: newTotal,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateErr) {
    logger.error({ error: updateErr, userId }, "Failed to update user_credits on remove");
    return { ok: false, error: updateErr.message || "Failed to update user credits." };
  }

  const { error: ledgerErr } = await supabase
    .from("credit_ledger")
    .insert({
      user_id: userId,
      delta: -actualRemoved,
      balance_total_after: newTotal,
      balance_used_after: row.credits_used,
      source: "admin_remove",
      reason: meta.reason || null,
      admin_user_id: meta.adminUserId || null,
      admin_email: meta.adminEmail || null,
      metadata: meta.metadata || {},
    });

  if (ledgerErr) {
    logger.warn({ error: ledgerErr, userId }, "[Credits] Failed to record credit_ledger row");
  }

  const remaining = Math.max(0, newTotal - row.credits_used);
  return {
    ok: true,
    remaining,
    total: newTotal,
    used: row.credits_used,
    removed: actualRemoved,
  };
}

/**
 * List credit ledger audit rows for a specific user.
 */
export async function listCreditLedger(userId: string): Promise<CreditLedgerRow[]> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    logger.warn({ error, userId }, "[Credits] Failed to fetch credit_ledger");
    return [];
  }

  return (data || []) as CreditLedgerRow[];
}

