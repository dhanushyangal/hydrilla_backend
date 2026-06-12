import { Router } from "express";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import {
  approveEmail,
  getInviteTokenStatus,
  normalizeEmail,
} from "../services/accessControl.js";

export const invitesRouter = Router();

const redeemAttempts = new Map<string, { count: number; resetAt: number }>();
const REDEEM_RATE_LIMIT = 10;
const REDEEM_WINDOW_MS = 60_000;

function checkRedeemRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = redeemAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    redeemAttempts.set(key, { count: 1, resetAt: now + REDEEM_WINDOW_MS });
    return true;
  }
  if (entry.count >= REDEEM_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

invitesRouter.get("/:token/validate", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 16) {
      return res.json({ valid: false, expired: false, used: false });
    }

    const { data, error } = await supabase
      .from("invite_tokens")
      .select("expires_at, use_count, max_uses")
      .eq("token", token)
      .maybeSingle();

    if (error || !data) {
      return res.json({ valid: false, expired: false, used: false });
    }

    const status = getInviteTokenStatus(data);
    return res.json({
      valid: status === "active",
      expired: status === "expired",
      used: status === "used",
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to validate invite token");
    res.status(500).json({ error: "Failed to validate invite" });
  }
});

invitesRouter.post("/:token/redeem", async (req, res) => {
  try {
    const { token } = req.params;
    const { email } = req.body;

    if (!token || !email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalized = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const rateKey = `${req.ip || "unknown"}:${token}`;
    if (!checkRedeemRateLimit(rateKey)) {
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }

    const { data: invite, error: fetchError } = await supabase
      .from("invite_tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (fetchError || !invite) {
      return res.status(404).json({ error: "Invalid invite link" });
    }

    const status = getInviteTokenStatus(invite);
    if (status !== "active") {
      return res.status(410).json({
        error: status === "expired" ? "This invite link has expired" : "This invite link has already been used",
      });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("invite_tokens")
      .update({
        use_count: invite.use_count + 1,
        used_at: now,
        used_by_email: normalized,
      })
      .eq("id", invite.id)
      .eq("use_count", invite.use_count)
      .select("id")
      .maybeSingle();

    if (updateError || !updated) {
      return res.status(410).json({ error: "This invite link has already been used" });
    }

    await approveEmail(normalized, invite.created_by, invite.id);

    res.json({
      success: true,
      message: "Access granted. Sign in with this email.",
      email: normalized,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to redeem invite token");
    res.status(500).json({ error: err.message || "Failed to redeem invite" });
  }
});
