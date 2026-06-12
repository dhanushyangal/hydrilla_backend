import crypto from "crypto";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  return config.adminEmails.some((e) => normalizeEmail(e) === normalized);
}

export function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "PGRST205";
}

export async function isEmailApproved(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (isAdminEmail(normalized)) return true;

  const { data, error } = await supabase
    .from("approved_emails")
    .select("email")
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      logger.warn("approved_emails table missing — run backend/sql/migration_invite_access.sql");
      return false;
    }
    logger.error({ err: error, email: normalized }, "Failed to check approved email");
    return false;
  }

  return !!data;
}

export async function approveEmail(
  email: string,
  approvedBy: string | null,
  inviteTokenId?: string
): Promise<void> {
  const normalized = normalizeEmail(email);

  const { error } = await supabase.from("approved_emails").upsert(
    {
      email: normalized,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      invite_token_id: inviteTokenId ?? null,
    },
    { onConflict: "email" }
  );

  if (error) {
    if (isMissingTableError(error)) {
      throw new Error(
        "Invite tables not set up. Run backend/sql/migration_invite_access.sql in Supabase SQL Editor."
      );
    }
    throw new Error(`Failed to approve email: ${error.message}`);
  }

  const { error: userError } = await supabase
    .from("users")
    .update({ is_approved: true, updated_at: new Date().toISOString() })
    .eq("email", normalized);

  if (userError && !String(userError.message).includes("is_approved")) {
    logger.warn({ err: userError, email: normalized }, "Could not update user is_approved flag");
  }
}

export async function resolveUserApproval(
  userId: string,
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;

  const approved = await isEmailApproved(email);
  if (!approved) return false;

  const { error } = await supabase
    .from("users")
    .update({ is_approved: true, updated_at: new Date().toISOString() })
    .eq("id", userId);

  if (error) {
    // Column may not exist until migration runs — approval still valid in memory
    logger.warn({ err: error, userId }, "Could not persist is_approved flag (run migration?)");
  }

  return true;
}

async function fetchUserEmailAndApproval(userId: string): Promise<{
  email: string | null;
  isApproved: boolean;
}> {
  const { data, error } = await supabase
    .from("users")
    .select("is_approved, email")
    .eq("id", userId)
    .maybeSingle();

  if (!error && data) {
    return { email: data.email, isApproved: !!data.is_approved };
  }

  // is_approved column may not exist yet — fall back to email only
  const { data: emailOnly, error: emailError } = await supabase
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (emailError || !emailOnly) {
    if (emailError) {
      logger.error({ err: emailError, userId }, "Failed to fetch user approval status");
    }
    return { email: null, isApproved: false };
  }

  return { email: emailOnly.email, isApproved: false };
}

export async function getUserIsApproved(userId: string): Promise<boolean> {
  const { email, isApproved } = await fetchUserEmailAndApproval(userId);

  if (email && isAdminEmail(email)) {
    await resolveUserApproval(userId, email);
    return true;
  }

  if (isApproved) return true;

  if (email) {
    return isEmailApproved(email);
  }

  return false;
}

export type InviteTokenStatus = "active" | "used" | "expired";

export function getInviteTokenStatus(row: {
  expires_at: string;
  use_count: number;
  max_uses: number;
}): InviteTokenStatus {
  if (new Date(row.expires_at) < new Date()) return "expired";
  if (row.use_count >= row.max_uses) return "used";
  return "active";
}

export const INVITE_MIGRATION_HINT =
  "Run backend/sql/migration_invite_access.sql in Supabase SQL Editor (or set DATABASE_URL and run npm run migrate:invite).";
