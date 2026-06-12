import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  generateInviteToken,
  getInviteTokenStatus,
  INVITE_MIGRATION_HINT,
  isMissingTableError,
} from "../services/accessControl.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.post("/invites", async (req, res) => {
  try {
    const userId = req.userId!;
    const token = generateInviteToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + config.inviteExpiryDays);

    const { data, error } = await supabase
      .from("invite_tokens")
      .insert({
        token,
        created_by: userId,
        expires_at: expiresAt.toISOString(),
        max_uses: 1,
        use_count: 0,
      })
      .select("id, expires_at, created_at")
      .single();

    if (error || !data) {
      logger.error({ err: error, userId }, "Failed to create invite token");
      if (isMissingTableError(error)) {
        return res.status(503).json({ error: INVITE_MIGRATION_HINT });
      }
      return res.status(500).json({ error: "Failed to create invite" });
    }

    const frontendUrl = config.frontendUrl.replace(/\/$/, "");
    res.json({
      inviteUrl: `${frontendUrl}/invite/${token}`,
      expiresAt: data.expires_at,
      createdAt: data.created_at,
      id: data.id,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to create invite");
    res.status(500).json({ error: err.message || "Failed to create invite" });
  }
});

adminRouter.get("/invites", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("invite_tokens")
      .select("id, token, created_at, expires_at, used_at, used_by_email, use_count, max_uses")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      logger.error({ err: error }, "Failed to list invite tokens");
      if (isMissingTableError(error)) {
        return res.status(503).json({ error: INVITE_MIGRATION_HINT, invites: [] });
      }
      return res.status(500).json({ error: "Failed to list invites" });
    }

    const frontendUrl = config.frontendUrl.replace(/\/$/, "");
    const invites = (data || []).map((row) => ({
      id: row.id,
      inviteUrl: `${frontendUrl}/invite/${row.token}`,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedByEmail: row.used_by_email,
      status: getInviteTokenStatus(row),
    }));

    res.json({ invites });
  } catch (err: any) {
    logger.error({ err }, "Failed to list invites");
    res.status(500).json({ error: err.message || "Failed to list invites" });
  }
});
