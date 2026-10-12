import { Router, Request, Response } from "express";
import crypto from "crypto";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { clerk, optionalAuth, requireAuth } from "../middleware/auth.js";
import { grantCredits } from "../services/credits.js";
import { sendCreditGrantEmail } from "../services/email.js";

export const adminCreditClaimsRouter = Router();
export const publicCreditClaimsRouter = Router();

async function getUserDetails(userId: string): Promise<{ email: string | null; name: string | null }> {
  const { data: dbUser } = await supabase
    .from("users")
    .select("email, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();

  if (dbUser?.email) {
    const fullName = [dbUser.first_name, dbUser.last_name].filter(Boolean).join(" ").trim() || null;
    return { email: dbUser.email, name: fullName };
  }

  try {
    const clerkUser = await clerk.users.getUser(userId);
    const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId);
    const email = primary?.emailAddress || clerkUser.emailAddresses[0]?.emailAddress || null;
    const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() || null;
    return { email, name };
  } catch (err: any) {
    logger.warn({ err: err?.message, userId }, "Failed to fetch user details from Clerk");
    return { email: null, name: null };
  }
}

// ============================================================
// Admin Routes (mounted under /api/admin/credit-claims)
// ============================================================

adminCreditClaimsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const amount = Number(req.body.amount);
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : null;
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt).toISOString() : null;
    const maxClaims = Number(req.body.maxClaims);
    const claimsLimit = Number.isInteger(maxClaims) && maxClaims > 0 ? maxClaims : 1;
    const rawAllowedEmail = typeof req.body.allowedEmail === "string" ? req.body.allowedEmail.trim() : "";
    const allowedEmail = rawAllowedEmail ? rawAllowedEmail.toLowerCase() : null;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    const token = crypto.randomBytes(16).toString("hex");

    const { data: link, error } = await supabase
      .from("credit_claim_links")
      .insert({
        token,
        amount,
        reason,
        expires_at: expiresAt,
        max_claims: claimsLimit,
        claims_used: 0,
        status: "active",
        allowed_email: allowedEmail,
        created_by_admin_id: req.userId || null,
        created_by_admin_email: req.userEmail || null,
      })
      .select("*")
      .single();

    if (error || !link) {
      logger.error({ error }, "Failed to create credit claim link");
      return res.status(500).json({ error: error?.message || "Failed to create claim link" });
    }

    const claimUrl = `${config.frontendUrl}/claim/${link.token}`;
    return res.json({
      success: true,
      link,
      claimUrl,
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/admin/credit-claims failed");
    return res.status(500).json({ error: "Failed to create claim link" });
  }
});

adminCreditClaimsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const baseQuery = supabase.from("credit_claim_links").select("*");
    const filteredQuery = req.query.status === "active" || req.query.status === "disabled"
      ? baseQuery.eq("status", req.query.status)
      : baseQuery;

    const { data, error } = await filteredQuery.order("created_at", { ascending: false }).limit(200);

    if (error) {
      logger.error({ error }, "Failed to list credit claim links");
      return res.status(500).json({ error: "Failed to list claim links" });
    }

    const links = (data || []).map((link) => ({
      ...link,
      claimUrl: `${config.frontendUrl}/claim/${link.token}`,
    }));

    return res.json({ links });
  } catch (err: any) {
    logger.error({ err }, "GET /api/admin/credit-claims failed");
    return res.status(500).json({ error: "Failed to list claim links" });
  }
});

adminCreditClaimsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Link ID is required" });
    }

    const patchPayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof req.body.status === "string" && ["active", "disabled"].includes(req.body.status)) {
      patchPayload.status = req.body.status;
    }
    if (req.body.expiresAt !== undefined) {
      patchPayload.expires_at = req.body.expiresAt ? new Date(req.body.expiresAt).toISOString() : null;
    }
    if (typeof req.body.maxClaims === "number" && req.body.maxClaims > 0) {
      patchPayload.max_claims = req.body.maxClaims;
    }

    const { data: updated, error } = await supabase
      .from("credit_claim_links")
      .update(patchPayload)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) {
      logger.error({ error, id }, "Failed to update credit claim link");
      return res.status(500).json({ error: "Failed to update claim link" });
    }

    if (!updated) {
      return res.status(404).json({ error: "Claim link not found" });
    }

    return res.json({
      success: true,
      link: {
        ...updated,
        claimUrl: `${config.frontendUrl}/claim/${updated.token}`,
      },
    });
  } catch (err: any) {
    logger.error({ err, id: req.params.id }, "PATCH /api/admin/credit-claims/:id failed");
    return res.status(500).json({ error: "Failed to update claim link" });
  }
});

// ============================================================
// Public / User Routes (mounted under /api/credits/claim)
// ============================================================

publicCreditClaimsRouter.get("/:token", optionalAuth, async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Token is required", status: "not_found" });
    }

    const { data: link, error } = await supabase
      .from("credit_claim_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (error || !link) {
      return res.status(404).json({
        status: "not_found",
        error: "Claim link not found or invalid.",
      });
    }

    if (link.status === "disabled") {
      return res.json({
        status: "disabled",
        amount: link.amount,
        reason: link.reason,
        expiresAt: link.expires_at,
      });
    }

    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
      return res.json({
        status: "expired",
        amount: link.amount,
        reason: link.reason,
        expiresAt: link.expires_at,
      });
    }

    if (link.claims_used >= link.max_claims) {
      return res.json({
        status: "exhausted",
        amount: link.amount,
        reason: link.reason,
        expiresAt: link.expires_at,
      });
    }

    if (req.userId) {
      const { data: alreadyClaimed } = await supabase
        .from("credit_ledger")
        .select("id")
        .eq("claim_link_id", link.id)
        .eq("user_id", req.userId)
        .maybeSingle();

      if (alreadyClaimed) {
        return res.json({
          status: "exhausted",
          amount: link.amount,
          reason: link.reason,
          expiresAt: link.expires_at,
          alreadyClaimedByUser: true,
        });
      }

      if (link.allowed_email) {
        const userDetails = await getUserDetails(req.userId);
        const linkEmail = link.allowed_email.trim().toLowerCase();
        const userEmail = (userDetails.email || "").trim().toLowerCase();

        if (!userEmail || userEmail !== linkEmail) {
          return res.json({
            status: "email_mismatch",
            amount: link.amount,
            reason: link.reason,
            allowedEmail: link.allowed_email,
            userEmail: userDetails.email,
          });
        }
      }

      return res.json({
        status: "ok",
        amount: link.amount,
        reason: link.reason,
        expiresAt: link.expires_at,
        requiresAuth: false,
      });
    }

    return res.json({
      status: "ok",
      amount: link.amount,
      reason: link.reason,
      expiresAt: link.expires_at,
      requiresAuth: true,
    });
  } catch (err: any) {
    logger.error({ err, token: req.params.token }, "GET /api/credits/claim/:token failed");
    return res.status(500).json({ error: "Failed to inspect claim link", status: "not_found" });
  }
});

publicCreditClaimsRouter.post("/:token", requireAuth, async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || "").trim();
    const userId = req.userId;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: link, error } = await supabase
      .from("credit_claim_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (error || !link) {
      return res.status(404).json({ error: "Claim link not found", status: "not_found" });
    }

    if (link.status === "disabled") {
      return res.status(400).json({ error: "This claim link has been disabled", status: "disabled" });
    }

    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: "This claim link has expired", status: "expired" });
    }

    if (link.claims_used >= link.max_claims) {
      return res.status(400).json({ error: "This claim link has reached its maximum claims", status: "exhausted" });
    }

    const { data: alreadyClaimed } = await supabase
      .from("credit_ledger")
      .select("id")
      .eq("claim_link_id", link.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (alreadyClaimed) {
      return res.status(400).json({ error: "You have already claimed this credit link", status: "exhausted" });
    }

    const userDetails = await getUserDetails(userId);
    if (link.allowed_email) {
      const linkEmail = link.allowed_email.trim().toLowerCase();
      const userEmail = (userDetails.email || "").trim().toLowerCase();

      if (!userEmail || userEmail !== linkEmail) {
        return res.status(403).json({
          error: `This credit link is restricted to ${link.allowed_email}`,
          status: "email_mismatch",
        });
      }
    }

    const grantRes = await grantCredits(userId, link.amount, {
      reason: link.reason || "Credit claim link",
      source: "claim_link",
      claimLinkId: link.id,
      metadata: { token: link.token },
    });

    if (!grantRes.ok) {
      return res.status(500).json({ error: grantRes.error });
    }

    await supabase
      .from("credit_claim_links")
      .update({
        claims_used: link.claims_used + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", link.id);

    if (userDetails.email) {
      await sendCreditGrantEmail(
        userDetails.email,
        userDetails.name,
        link.amount,
        link.reason,
        grantRes.remaining
      );
    }

    return res.json({
      success: true,
      amount: link.amount,
      remaining: grantRes.remaining,
      total: grantRes.total,
    });
  } catch (err: any) {
    logger.error({ err, token: req.params.token }, "POST /api/credits/claim/:token failed");
    return res.status(500).json({ error: "Failed to claim credits" });
  }
});
