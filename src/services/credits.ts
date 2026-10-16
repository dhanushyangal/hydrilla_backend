import { supabase } from "../db.js";
import { logger } from "../logger.js";

export const FREE_TIER_CREDITS = 100;

export type CreditsRow = {
  id: string;
  credits_used: number;
  credits_total: number;
  credits_bonus: number;
  plan: string | null;
  reset_at: string | null;
};

type DeductRpcRow = {
  remaining: number;
  success: boolean;
  period_used_after?: number;
  bonus_after?: number;
  period_taken?: number;
  bonus_taken?: number;
};

type RefundRpcRow = {
  remaining: number;
  success: boolean;
  period_used_after?: number;
  bonus_after?: number;
  period_restored?: number;
  bonus_restored?: number;
};

const HOLD_BLOCK_STATUSES = new Set(["on_hold", "paused", "failed"]);

function addOneMonth(from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function availableCredits(row: {
  credits_total: number;
  credits_used: number;
  credits_bonus?: number | null;
}): number {
  const period = Math.max(0, Number(row.credits_total) - Number(row.credits_used));
  const bonus = Math.max(0, Number(row.credits_bonus) || 0);
  return period + bonus;
}

function mapCreditsRow(row: Record<string, unknown> | null): CreditsRow | null {
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    credits_used: Number(row.credits_used) || 0,
    credits_total: Number(row.credits_total) || 0,
    credits_bonus: Number(row.credits_bonus) || 0,
    plan: (row.plan as string | null) ?? null,
    reset_at: (row.reset_at as string | null) ?? null,
  };
}

/**
 * Get user_credits row for a user (by user_id only).
 */
export async function getCreditsRow(userId: string): Promise<CreditsRow | null> {
  const row = (
    await supabase
      .from("user_credits")
      .select("id, credits_used, credits_total, credits_bonus, plan, reset_at")
      .eq("user_id", userId)
      .maybeSingle()
  ).data;
  return mapCreditsRow(row);
}

async function insertPeriodResetLedger(
  userId: string,
  row: CreditsRow,
  reason: string
): Promise<void> {
  const { error } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: 0,
    balance_total_after: row.credits_total,
    balance_used_after: row.credits_used,
    source: "period_reset",
    reason,
    metadata: {
      credits_bonus: row.credits_bonus,
      reset_at: row.reset_at,
    },
  });
  if (error) {
    logger.warn({ error, userId }, "[Credits] Failed to record period_reset ledger");
  }
}

/**
 * Free tier: when reset_at is due (or missing), hard-reset period to 100/0 and advance reset_at.
 * Bonus is preserved. Paid plans are left alone (Dodo renewal owns their reset).
 * Skips users who still have a subscription row (including on_hold/paused/failed) so hold
 * does not look like free tier and wipe a paid allotment.
 */
export async function applyFreePeriodResetIfDue(userId: string): Promise<CreditsRow | null> {
  const row = await getCreditsRow(userId);
  if (!row) {
    return null;
  }
  if (row.plan) {
    return row;
  }

  const { data: subs } = await supabase
    .from("user_subscriptions")
    .select("status")
    .eq("user_id", userId)
    .in("status", ["active", "past_due", "on_hold", "paused", "failed", "pending"])
    .limit(1);
  if (subs && subs.length > 0) {
    return row;
  }

  const now = new Date();
  const resetAt = row.reset_at ? new Date(row.reset_at) : null;
  const due = !resetAt || Number.isNaN(resetAt.getTime()) || resetAt.getTime() <= now.getTime();
  if (!due) {
    return row;
  }

  const base = resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : now;
  const nextReset = addOneMonth(base);
  // If we jumped multiple months offline, keep advancing until nextReset is in the future.
  while (nextReset.getTime() <= now.getTime()) {
    nextReset.setUTCMonth(nextReset.getUTCMonth() + 1);
  }

  const { data: updated, error } = await supabase
    .from("user_credits")
    .update({
      credits_total: FREE_TIER_CREDITS,
      credits_used: 0,
      reset_at: nextReset.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", row.id)
    .select("id, credits_used, credits_total, credits_bonus, plan, reset_at")
    .single();

  if (error || !updated) {
    logger.error({ error, userId }, "Failed to apply free period reset");
    return row;
  }

  const mapped = mapCreditsRow(updated)!;
  await insertPeriodResetLedger(userId, mapped, "Free monthly credit reset");
  logger.info({ userId, resetAt: mapped.reset_at }, "Free-tier credits period reset");
  return mapped;
}

/**
 * Ensure a user has a credits row. Creates free-tier (100 credits) with reset_at if missing.
 */
export async function ensureCreditsRow(userId: string): Promise<CreditsRow | null> {
  const existing = await getCreditsRow(userId);
  if (existing) {
    return applyFreePeriodResetIfDue(userId);
  }

  const resetAt = addOneMonth(new Date()).toISOString();
  logger.info({ userId }, "Creating free-tier credits row (100 credits)");
  const { data: newRow, error: insertErr } = await supabase
    .from("user_credits")
    .insert({
      user_id: userId,
      plan: null,
      credits_total: FREE_TIER_CREDITS,
      credits_used: 0,
      credits_bonus: 0,
      reset_at: resetAt,
    })
    .select("id, credits_used, credits_total, credits_bonus, plan, reset_at")
    .single();

  if (!insertErr && newRow) {
    return mapCreditsRow(newRow);
  }

  if (insertErr?.code === "23505") {
    return applyFreePeriodResetIfDue(userId);
  }

  logger.error({ error: insertErr, userId }, "Failed to create free-tier credits row");
  return null;
}

async function subscriptionBlocksSpend(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("status")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    logger.warn({ error, userId }, "Failed to load subscription for spend gate");
    return false;
  }

  const rows = data || [];
  if (rows.length === 0) {
    return false;
  }

  // Block only when the latest relevant status is a hold/pause/fail and none are active/past_due.
  const hasEntitled = rows.some((row) => row.status === "active" || row.status === "past_due");
  if (hasEntitled) {
    return false;
  }
  return rows.some((row) => HOLD_BLOCK_STATUSES.has(String(row.status || "")));
}

async function insertSpendLedger(
  userId: string,
  amount: number,
  row: CreditsRow,
  source: "spend" | "refund",
  meta: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: source === "spend" ? -amount : amount,
    balance_total_after: row.credits_total,
    balance_used_after: row.credits_used,
    source,
    reason: source === "spend" ? "Generation spend" : "Generation refund",
    metadata: {
      ...meta,
      credits_bonus: row.credits_bonus,
      remaining: availableCredits(row),
    },
  });
  if (error) {
    logger.warn({ error, userId, source }, "[Credits] Failed to record spend/refund ledger");
  }
}

/**
 * Deduct credits for the user. Atomic RPC only (fail closed if RPC missing).
 * Spends period remaining first, then bonus. Blocks when subscription is on_hold/paused/failed.
 */
export async function deductCredit(
  userId: string,
  amount: number = 1,
  requireCredits: boolean = true
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  if (amount <= 0) {
    return { ok: true, remaining: 0 };
  }

  if (await subscriptionBlocksSpend(userId)) {
    return {
      ok: false,
      error: "Subscription is on hold. Update billing to continue generating.",
    };
  }

  const row = await ensureCreditsRow(userId);

  if (!row) {
    if (requireCredits) {
      return { ok: false, error: "No credit balance. Please subscribe to generate." };
    }
    return { ok: true, remaining: 0 };
  }

  const remainingBefore = availableCredits(row);
  if (remainingBefore < amount) {
    return {
      ok: false,
      error: `Insufficient credits. You have ${remainingBefore} left; ${amount} required.`,
    };
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc("deduct_user_credits", {
    p_credits_row_id: row.id,
    p_amount: amount,
  });

  if (rpcError) {
    logger.error({ error: rpcError, userId }, "deduct_user_credits RPC failed (fail closed)");
    return {
      ok: false,
      error: "Credits service temporarily unavailable. Please try again shortly.",
    };
  }

  if (!rpcData || !Array.isArray(rpcData) || rpcData.length === 0) {
    logger.error({ userId }, "deduct_user_credits RPC returned empty result");
    return {
      ok: false,
      error: "Credits service temporarily unavailable. Please try again shortly.",
    };
  }

  const first = rpcData[0] as DeductRpcRow;
  if (!first.success) {
    return {
      ok: false,
      error: `Insufficient credits. You have ${first.remaining} left; ${amount} required.`,
    };
  }

  const after: CreditsRow = {
    ...row,
    credits_used: Number(first.period_used_after ?? row.credits_used),
    credits_bonus: Number(first.bonus_after ?? row.credits_bonus),
  };
  await insertSpendLedger(userId, amount, after, "spend", {
    period_taken: first.period_taken ?? 0,
    bonus_taken: first.bonus_taken ?? 0,
  });

  logger.info({ userId, remaining: first.remaining }, "Credit deducted (atomic)");
  return { ok: true, remaining: first.remaining };
}

/** Give back credits charged for an operation that failed upstream. */
export async function refundCredit(userId: string, amount: number): Promise<void> {
  if (amount <= 0) {
    return;
  }
  const row = await getCreditsRow(userId);
  if (!row) {
    return;
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc("refund_user_credits", {
    p_credits_row_id: row.id,
    p_amount: amount,
  });

  if (rpcError) {
    logger.error({ error: rpcError, userId, amount }, "refund_user_credits RPC failed (fail closed)");
    return;
  }

  if (!rpcData || !Array.isArray(rpcData) || rpcData.length === 0) {
    logger.error({ userId, amount }, "refund_user_credits RPC returned empty result");
    return;
  }

  const first = rpcData[0] as RefundRpcRow;
  if (!first.success) {
    logger.warn({ userId, amount, first }, "refund_user_credits reported unsuccessful");
    return;
  }

  const after: CreditsRow = {
    ...row,
    credits_used: Number(first.period_used_after ?? row.credits_used),
    credits_bonus: Number(first.bonus_after ?? row.credits_bonus),
  };
  await insertSpendLedger(userId, amount, after, "refund", {
    period_restored: first.period_restored ?? 0,
    bonus_restored: first.bonus_restored ?? 0,
  });

  logger.info({ userId, amount, remaining: first.remaining }, "Credits refunded (atomic)");
}

export interface CreditLedgerRow {
  id: string;
  user_id: string;
  delta: number;
  balance_total_after: number;
  balance_used_after: number;
  source:
    | "admin_grant"
    | "admin_remove"
    | "claim_link"
    | "system"
    | "spend"
    | "refund"
    | "period_reset";
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
 * Grant credits to a user into credits_bonus (survives period renewal) and log ledger.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  meta: GrantCreditsOptions = {}
): Promise<{ ok: true; remaining: number; total: number; used: number; bonus: number } | { ok: false; error: string }> {
  if (amount <= 0) {
    return { ok: false, error: "Grant amount must be greater than zero." };
  }

  const row = await ensureCreditsRow(userId);
  if (!row) {
    return { ok: false, error: "Failed to load user credits row." };
  }

  const newBonus = row.credits_bonus + amount;
  const { error: updateErr } = await supabase
    .from("user_credits")
    .update({
      credits_bonus: newBonus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateErr) {
    logger.error({ error: updateErr, userId }, "Failed to update user_credits on grant");
    return { ok: false, error: updateErr.message || "Failed to update user credits." };
  }

  const { error: ledgerErr } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: amount,
    balance_total_after: row.credits_total,
    balance_used_after: row.credits_used,
    source: meta.source || "admin_grant",
    reason: meta.reason || null,
    admin_user_id: meta.adminUserId || null,
    admin_email: meta.adminEmail || null,
    claim_link_id: meta.claimLinkId || null,
    metadata: {
      ...(meta.metadata || {}),
      credits_bonus_after: newBonus,
    },
  });

  if (ledgerErr) {
    logger.warn({ error: ledgerErr, userId }, "[Credits] Failed to record credit_ledger row");
  }

  const remaining = availableCredits({
    credits_total: row.credits_total,
    credits_used: row.credits_used,
    credits_bonus: newBonus,
  });
  return {
    ok: true,
    remaining,
    total: row.credits_total,
    used: row.credits_used,
    bonus: newBonus,
  };
}

/**
 * Remove credits from bonus first, then from unused period total (never below used).
 */
export async function removeCredits(
  userId: string,
  amount: number,
  meta: RemoveCreditsOptions = {}
): Promise<
  | { ok: true; remaining: number; total: number; used: number; bonus: number; removed: number }
  | { ok: false; error: string }
> {
  if (amount <= 0) {
    return { ok: false, error: "Remove amount must be greater than zero." };
  }

  const row = await ensureCreditsRow(userId);
  if (!row) {
    return { ok: false, error: "Failed to load user credits row." };
  }

  const fromBonus = Math.min(row.credits_bonus, amount);
  const remainingToRemove = amount - fromBonus;
  const periodUnused = Math.max(0, row.credits_total - row.credits_used);
  const fromPeriod = Math.min(periodUnused, remainingToRemove);
  const actualRemoved = fromBonus + fromPeriod;

  if (actualRemoved <= 0) {
    return { ok: false, error: "Cannot remove credits below used balance." };
  }

  const newBonus = row.credits_bonus - fromBonus;
  const newTotal = row.credits_total - fromPeriod;

  const { error: updateErr } = await supabase
    .from("user_credits")
    .update({
      credits_bonus: newBonus,
      credits_total: newTotal,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateErr) {
    logger.error({ error: updateErr, userId }, "Failed to update user_credits on remove");
    return { ok: false, error: updateErr.message || "Failed to update user credits." };
  }

  const { error: ledgerErr } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: -actualRemoved,
    balance_total_after: newTotal,
    balance_used_after: row.credits_used,
    source: "admin_remove",
    reason: meta.reason || null,
    admin_user_id: meta.adminUserId || null,
    admin_email: meta.adminEmail || null,
    metadata: {
      ...(meta.metadata || {}),
      credits_bonus_after: newBonus,
      from_bonus: fromBonus,
      from_period: fromPeriod,
    },
  });

  if (ledgerErr) {
    logger.warn({ error: ledgerErr, userId }, "[Credits] Failed to record credit_ledger row");
  }

  const remaining = availableCredits({
    credits_total: newTotal,
    credits_used: row.credits_used,
    credits_bonus: newBonus,
  });
  return {
    ok: true,
    remaining,
    total: newTotal,
    used: row.credits_used,
    bonus: newBonus,
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
