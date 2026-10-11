import { Router, Request, Response } from "express";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getDodoPaymentsClient } from "../lib/dodopayments.js";
import { captureServerEvent, flushPostHog } from "../lib/posthog.js";

// ============================================================================
// DODO PAYMENTS - Subscription Integration
// Plans: starter (900 credits/mo), pro (3000 credits/mo)
// Webhook: POST /api/payments/webhook/dodo
// ============================================================================

export const paymentsRouter = Router();

const PAID_PLANS = ["starter", "pro"] as const;
type PaidPlan = (typeof PAID_PLANS)[number];

function isPaidPlan(plan: unknown): plan is PaidPlan {
  return typeof plan === "string" && (PAID_PLANS as readonly string[]).includes(plan);
}

/** Current catalog only. Legacy creator/studio rows are not Starter or Pro. */
function canonicalizePlan(plan: unknown): PaidPlan | null {
  if (plan === "starter" || plan === "pro") return plan;
  return null;
}

/** Checkout links may still send the previous names. */
function parseCheckoutPlan(plan: unknown): PaidPlan | null {
  if (plan === "creator" || plan === "starter") return "starter";
  if (plan === "studio" || plan === "pro") return "pro";
  return null;
}

/** Get the plan name ('starter' | 'pro') from a Dodo product_id */
function getPlanFromProductId(productId: string): PaidPlan | null {
  if (productId && productId === config.dodoPayment.starterProductId) return "starter";
  if (productId && productId === config.dodoPayment.proProductId) return "pro";
  return null;
}

function resolvePaidPlan(data: any, productId?: string): PaidPlan | null {
  const fromProduct = productId ? getPlanFromProductId(productId) : null;
  if (fromProduct) return fromProduct;
  return parseCheckoutPlan(data?.metadata?.plan);
}

/** Paid access stays while the subscription is active, or past_due during a grace period. on_hold does not. */
function entitledPlan(subscription: { status?: string; product_id?: string | null } | null): PaidPlan | null {
  if (!subscription) return null;
  if (subscription.status !== "active" && subscription.status !== "past_due") return null;
  return getPlanFromProductId(subscription.product_id || "");
}

/** Credits granted per plan per billing cycle */
const PLAN_CREDITS: Record<PaidPlan, number> = {
  starter: 900,
  pro: 3000,
};

const FREE_CREDITS = 100;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getActiveSubscription(userId: string) {
  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["active", "on_hold", "past_due", "paused"])
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    logger.error({ error: error.message, userId }, "Failed to load active subscription");
    return null;
  }
  const rows = data || [];
  return rows.find((row) => entitledPlan(row)) || rows[0] || null;
}

async function signedInUserOwnsCheckout(callerUserId: string, payment: any, sub: any): Promise<boolean> {
  const metaUser = nonEmptyString(payment?.metadata?.user_id) || nonEmptyString(sub?.metadata?.user_id);
  if (metaUser) return metaUser === callerUserId;

  const { data: me } = await supabase.from("users").select("email").eq("id", callerUserId).maybeSingle();
  const mine = (me?.email || "").trim().toLowerCase();
  if (!mine) return false;
  const theirs = [payment?.customer?.email, sub?.customer?.email, sub?.customer_email, sub?.email, payment?.metadata?.email, sub?.metadata?.email]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter(Boolean);
  return theirs.includes(mine);
}

async function persistSubscriptionStatus(subscriptionId: string, rawStatus: string) {
  if (!subscriptionId) return;
  const { data: existing } = await supabase
    .from("user_subscriptions")
    .select("metadata")
    .eq("dodo_subscription_id", subscriptionId)
    .maybeSingle();
  const previousMeta = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
  const metadata = { ...previousMeta, dodo_status: rawStatus };
  const attempt = async (status: string) =>
    supabase
      .from("user_subscriptions")
      .update({ status, metadata, updated_at: new Date().toISOString() })
      .eq("dodo_subscription_id", subscriptionId);

  let result = await attempt(rawStatus);
  if (result.error?.code === "23514" && (rawStatus === "paused" || rawStatus === "past_due")) {
    result = await attempt(rawStatus === "paused" ? "on_hold" : "active");
  }
  if (result.error) logger.error({ error: result.error, subscriptionId, rawStatus }, "Failed to store subscription status");
}

/**
 * Persist subscription rows against the live CHECK.
 * Preferred values are starter and pro. If the database check has not been
 * widened yet, fall back to the legacy creator/studio values so the row still saves.
 */
async function writeUserSubscription(
  kind: "upsert" | "update",
  payload: Record<string, unknown>,
  dodoSubscriptionId?: string
) {
  const run = (row: Record<string, unknown>) =>
    kind === "upsert"
      ? supabase.from("user_subscriptions").upsert(row, { onConflict: "dodo_subscription_id" })
      : supabase.from("user_subscriptions").update(row).eq("dodo_subscription_id", dodoSubscriptionId!);

  let result = await run(payload);
  const legacyPlan = payload.plan === "starter" ? "creator" : payload.plan === "pro" ? "studio" : null;
  if (result.error?.code === "23514" && legacyPlan) {
    logger.warn(
      { plan: payload.plan, fallback: legacyPlan },
      "user_subscriptions check rejected current plan name; saving legacy value"
    );
    result = await run({ ...payload, plan: legacyPlan });
  }
  return result;
}

// ============================================================================
// TEST ENDPOINT
// GET /api/payments/test
// ============================================================================
paymentsRouter.get("/test", requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.json({
    ok: true,
    mode: config.dodoPayment.mode,
    hasApiKey: !!config.dodoPayment.apiKey,
    hasWebhookSecret: !!config.dodoPayment.webhookSecret,
    starterProductId: config.dodoPayment.starterProductId || "(not set)",
    proProductId: config.dodoPayment.proProductId || "(not set)",
  });
});

// ============================================================================
// CREATE SUBSCRIPTION CHECKOUT SESSION
// POST /api/payments/create-checkout
// Body: { plan: "starter" | "pro", email: string }
// ============================================================================
paymentsRouter.post("/create-checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    // Validate early so invalid requests fail fast (better TTFB for client)
    const { plan, email } = req.body ?? {};
    const userId = (req as any).userId || null;

    const paidPlan = parseCheckoutPlan(plan);
    if (!paidPlan) {
      return res.status(400).json({ error: "plan must be 'starter' or 'pro'" });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const productId = paidPlan === "starter"
      ? config.dodoPayment.starterProductId
      : config.dodoPayment.proProductId;

    if (!productId) {
      logger.error({ plan: paidPlan }, "Product ID not configured for plan");
      return res.status(500).json({ error: `Payment product for ${paidPlan} plan not configured` });
    }

    const returnUrl = config.dodoPayment.returnUrl ||
      `${config.email.frontendUrl}/checkout/success`;
    const cancelUrl = `${config.frontendUrl.replace(/\/+$/, "")}/pricing`;

    const dodo = getDodoPaymentsClient();

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email },
      return_url: returnUrl,
      cancel_url: cancelUrl,
      metadata: {
        plan: paidPlan,
        user_id: userId || "",
        email,
      },
    });

    logger.info({ plan: paidPlan, email, sessionId: session.session_id }, "Checkout session created");

    captureServerEvent(userId, "checkout_session_created", {
      plan: paidPlan,
      session_id: session.session_id,
    });
    void flushPostHog();

    res.json({
      checkoutUrl: session.checkout_url,
      sessionId: session.session_id,
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error creating checkout session");
    captureServerEvent((req as any).userId || null, "checkout_session_failed", {
      plan: req.body?.plan || null,
    });
    void flushPostHog();
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ============================================================================
// GET USER SUBSCRIPTION STATUS
// GET /api/payments/subscription
// ============================================================================
paymentsRouter.get("/subscription", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const subscription = await getActiveSubscription(userId);
    const plan = entitledPlan(subscription);

    res.json({
      subscription: plan && subscription ? { ...subscription, plan } : null,
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching subscription");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// GET BILLING (current plan + this user's payment history)
// GET /api/payments/billing
// ============================================================================
paymentsRouter.get("/billing", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const subscription = await getActiveSubscription(userId);
    const plan = entitledPlan(subscription);
    const payments = await listPaymentsForPerson(userId);
    const meta = (subscription?.metadata || {}) as Record<string, unknown>;
    const cancelAtPeriodEnd = Boolean(plan && meta.cancel_at_next_billing_date === true);
    const periodEnd = subscription?.current_period_end || (typeof meta.next_billing_date === "string" ? meta.next_billing_date : null);

    res.json({
      plan,
      renewsAt: plan ? periodEnd : null,
      cancelAtPeriodEnd,
      accessUntil: cancelAtPeriodEnd ? periodEnd : null,
      payments,
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching billing");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// CANCEL AT NEXT BILLING DATE
// POST /api/payments/cancel
// The subscription stays active until the period the customer already paid for ends.
// ============================================================================
paymentsRouter.post("/cancel", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const subscription = await getActiveSubscription(userId);
    const plan = entitledPlan(subscription);
    const subscriptionId = subscription?.dodo_subscription_id;
    if (!plan || !subscriptionId) {
      return res.status(400).json({ error: "No active Starter or Pro plan to cancel" });
    }

    const already = (subscription.metadata as Record<string, unknown> | null)?.cancel_at_next_billing_date === true;
    if (!already) {
      const dodo = getDodoPaymentsClient();
      const updated: any = await dodo.subscriptions.update(subscriptionId, {
        cancel_at_next_billing_date: true,
        cancel_reason: "cancelled_by_customer",
      });
      await markCancelScheduled(subscriptionId, updated || {});
    }

    const { data: row } = await supabase
      .from("user_subscriptions")
      .select("current_period_end, metadata")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
    const accessUntil = row?.current_period_end || (row?.metadata as any)?.next_billing_date || subscription.current_period_end || null;

    res.json({ ok: true, plan, cancelAtPeriodEnd: true, accessUntil });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error scheduling cancellation");
    res.status(500).json({ error: "Failed to cancel renewal" });
  }
});

// ============================================================================
// SYNC SUBSCRIPTION FROM DODO (use when webhook can't reach you, e.g. localhost)
// POST /api/payments/sync?payment_id=xxx  OR  ?subscription_id=xxx
// Also accepts: POST body { payment_id, subscription_id }
// Fetches subscription from Dodo API and writes to DB (same as webhook would).
// ============================================================================
paymentsRouter.post("/sync", requireAuth, async (req: Request, res: Response) => {
  try {
    const paymentId = (req.query.payment_id || req.body?.payment_id) as string | undefined;
    const subscriptionIdParam = (req.query.subscription_id || req.body?.subscription_id) as string | undefined;
    // If the calling user is authenticated, use their userId to backfill immediately
    const callerUserId: string | null = (req as any).userId || null;

    let subscriptionId: string | undefined = subscriptionIdParam;
    let payment: any = null;

    const dodo = getDodoPaymentsClient();

    if (paymentId) {
      try {
        payment = await dodo.payments.retrieve(paymentId);
        subscriptionId = subscriptionId || payment.subscription_id || payment.subscription?.id;
        logger.info({ paymentId, subscriptionId }, "Resolved subscription_id from payment_id");
      } catch (err: any) {
        logger.warn({ paymentId, err: err?.message }, "Could not fetch payment from Dodo");
      }
    }

    if (!subscriptionId) {
      return res.status(400).json({ error: "Provide payment_id or subscription_id in query or body" });
    }

    let sub: any;
    try {
      sub = await dodo.subscriptions.retrieve(subscriptionId);
    } catch (err: any) {
      logger.warn({ subscriptionId, err: err?.message }, "Could not fetch subscription from Dodo");
      return res.status(400).json({ error: "Invalid subscription_id or could not fetch from Dodo" });
    }

    if (!payment && subscriptionId) {
      try {
        const page = await dodo.payments.list({ subscription_id: subscriptionId, page_size: 10 });
        const items = page.items || [];
        payment = items.find((item: any) => item.status === "succeeded") || null;
      } catch (err: any) {
        logger.warn({ subscriptionId, err: err?.message }, "Could not list payments for subscription");
      }
    }

    if (!callerUserId || !(await signedInUserOwnsCheckout(callerUserId, payment, sub))) {
      logger.warn({ callerUserId, subscriptionId, paymentId: payment?.payment_id || paymentId }, "Sync rejected: payment does not belong to this account");
      return res.status(403).json({ error: "This payment belongs to a different account", granted: false });
    }

    const dodoStatus = typeof sub.status === "string" ? sub.status : "pending";
    const customerEmail: string = sub.customer?.email || sub.customer_email || sub.email || payment?.customer?.email || "";
    const paid = payment?.status === "succeeded";
    const data = {
      subscription_id: sub.id || sub.subscription_id || subscriptionId,
      product_id: sub.product_id,
      customer_id: sub.customer_id,
      customer: sub.customer || { email: customerEmail, name: sub.customer_name },
      email: customerEmail,
      currency: sub.currency || "INR",
      current_period_start: sub.current_period_start || sub.previous_billing_date,
      current_period_end: sub.current_period_end || sub.next_billing_date,
      next_billing_date: sub.next_billing_date,
      cancel_at_next_billing_date: sub.cancel_at_next_billing_date === true,
      recurring_pre_tax_amount: sub.recurring_pre_tax_amount ?? 0,
      metadata: sub.metadata || {},
      status: dodoStatus,
      _callerUserId: callerUserId,
    };

    if (payment && (payment.status === "succeeded" || payment.status === "failed")) {
      await recordSubscriptionPayment({
        paymentId: payment.payment_id || paymentId,
        subscriptionId,
        email: payment.customer?.email || customerEmail,
        userId: payment.metadata?.user_id || callerUserId,
        amountCents: payment.total_amount ?? payment.amount ?? 0,
        currency: payment.currency || sub.currency || "INR",
        status: payment.status === "failed" ? "failed" : "succeeded",
        plan: resolvePaidPlan(payment, sub.product_id),
        webhookId: `sync-${payment.payment_id || paymentId}`,
        metadata: { source: "sync", payment_id: payment.payment_id || paymentId, dodo_status: dodoStatus },
      });
    }

    let granted = false;
    if (paid && (dodoStatus === "active" || dodoStatus === "past_due")) {
      const beforeCredits = (
        await supabase.from("user_credits").select("subscription_id, plan, credits_total").eq("user_id", callerUserId).maybeSingle()
      ).data;
      await handleSubscriptionActive(data, `sync-${payment.payment_id || paymentId || subscriptionId}`);
      await resetCreditsForNewPaidPeriod(callerUserId, data, beforeCredits);
      if (dodoStatus === "past_due") await persistSubscriptionStatus(data.subscription_id, "past_due");
      if (data.cancel_at_next_billing_date) await markCancelScheduled(data.subscription_id, data);
      granted = dodoStatus === "active";
    } else if (dodoStatus === "on_hold" || dodoStatus === "paused") {
      await handleSubscriptionOnHold({ ...data, subscription_id: data.subscription_id });
      await persistSubscriptionStatus(data.subscription_id, dodoStatus);
    } else if (dodoStatus === "cancelled" || dodoStatus === "expired") {
      await handleSubscriptionCancelled(data, dodoStatus === "expired" ? "subscription.expired" : "subscription.cancelled");
    } else if (dodoStatus === "failed") {
      await handleSubscriptionFailed(data);
    } else if (dodoStatus !== "active") {
      await persistSubscriptionStatus(data.subscription_id, "pending");
    }

    logger.info({ subscriptionId: data.subscription_id, callerUserId, dodoStatus, paid, granted }, "Sync completed");
    res.json({
      ok: true,
      granted,
      status: dodoStatus,
      subscription_id: data.subscription_id,
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error syncing subscription");
    res.status(500).json({ error: error?.message || "Sync failed" });
  }
});

// ============================================================================
// GET USER CREDITS
// GET /api/payments/credits
// ============================================================================
paymentsRouter.get("/credits", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    let credits = (await supabase.from("user_credits").select("*").eq("user_id", userId).maybeSingle()).data;
    const subscription = await getActiveSubscription(userId);
    const subscriptionPlan = entitledPlan(subscription);

    if (!credits) {
      if (subscriptionPlan) {
        logger.info({ userId, plan: subscriptionPlan }, "No credits row but active subscription – creating paid credits row");
        const { data: newRow, error: insertErr } = await supabase
          .from("user_credits")
          .insert({
            user_id: userId,
            plan: subscriptionPlan,
            credits_total: PLAN_CREDITS[subscriptionPlan],
            credits_used: 0,
            subscription_id: subscription?.dodo_subscription_id || null,
            reset_at: subscription?.current_period_end || null,
          })
          .select()
          .single();
        if (!insertErr && newRow) credits = newRow;
        else if (insertErr?.code === "23505") credits = (await supabase.from("user_credits").select("*").eq("user_id", userId).maybeSingle()).data;
        else if (insertErr) logger.error({ error: insertErr, userId }, "Failed to create paid credits row");
      } else {
        logger.info({ userId }, "No credits row – creating free tier (100 credits)");
        const { data: newRow, error: insertErr } = await supabase
          .from("user_credits")
          .insert({
            user_id: userId,
            plan: null,
            credits_total: FREE_CREDITS,
            credits_used: 0,
          })
          .select()
          .single();
        if (!insertErr && newRow) credits = newRow;
        else if (insertErr?.code === "23505") credits = (await supabase.from("user_credits").select("*").eq("user_id", userId).maybeSingle()).data;
        else if (insertErr) logger.error({ error: insertErr, userId }, "Failed to create free credits row");
      }
    } else if (credits && !subscriptionPlan && credits.plan) {
      const { error: clearErr } = await supabase
        .from("user_credits")
        .update({ plan: null, updated_at: new Date().toISOString() })
        .eq("id", credits.id);
      if (clearErr) logger.error({ error: clearErr, userId }, "Failed to clear stale credits plan");
      else credits.plan = null;
    } else if (!canonicalizePlan(credits.plan) && subscriptionPlan) {
      // Backfill plan from the existing subscription row. Do not delete usage.
      // If the credits row is still the free-tier 100, restore paid allotment.
      const updateData: Record<string, unknown> = {
        plan: subscriptionPlan,
        subscription_id: credits.subscription_id || subscription?.dodo_subscription_id || null,
        updated_at: new Date().toISOString(),
      };
      if (credits.credits_total === FREE_CREDITS) {
        updateData.credits_total = PLAN_CREDITS[subscriptionPlan];
      }
      const { error: backfillErr } = await supabase
        .from("user_credits")
        .update(updateData)
        .eq("id", credits.id);
      if (backfillErr) {
        logger.error({ error: backfillErr, userId }, "Failed to backfill user_credits.plan from subscription");
      } else {
        credits.plan = subscriptionPlan;
        if (typeof updateData.credits_total === "number") {
          credits.credits_total = updateData.credits_total;
        }
      }
    }

    if (!credits) {
      return res.json({
        credits: {
          used: 0,
          total: subscriptionPlan ? PLAN_CREDITS[subscriptionPlan] : FREE_CREDITS,
          plan: subscriptionPlan,
          remaining: subscriptionPlan ? PLAN_CREDITS[subscriptionPlan] : FREE_CREDITS,
        },
      });
    }

    res.json({
      credits: {
        used: credits.credits_used,
        total: credits.credits_total,
        remaining: Math.max(0, credits.credits_total - credits.credits_used),
        plan: subscriptionPlan,
        resetAt: credits.reset_at,
      },
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching credits");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// GET USAGE BREAKDOWN BY JOB TYPE
// GET /api/payments/usage
// Returns credits used per category (3D, image gen, edit) from jobs table.
// ============================================================================
type UsageCategory = "3d" | "image" | "edit";
const THREE_D_GENERATE_TYPES = new Set(["ImageTo3D", "TextTo3D", "Water", "CodeSculpt"]);

function usageCategory(generateType: string, hasGlb: boolean): UsageCategory {
  // Legacy "Combined" rows (removed combine feature) are billed as edits.
  if (generateType === "EditImage" || generateType === "Combined") return "edit";
  if (generateType === "TextToImage") return "image";
  if (hasGlb || THREE_D_GENERATE_TYPES.has(generateType)) return "3d";
  return "image";
}

const USAGE_HISTORY_LABELS: Record<UsageCategory, string> = {
  "3d": "3D model",
  image: "Image generation",
  edit: "Edit image",
};

paymentsRouter.get("/usage", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("generate_type, credits_used, result_glb_url")
      .eq("user_id", userId)
      .gt("credits_used", 0);

    if (error) {
      logger.error({ error: error.message }, "Error fetching usage breakdown");
      return res.status(500).json({ error: "Failed to load usage" });
    }

    type BreakdownItem = { type: string; label: string; credits: number; count: number };
    const map: Record<string, BreakdownItem> = {
      "3d": { type: "3d", label: "3D model generation", credits: 0, count: 0 },
      image: { type: "image", label: "Image generation", credits: 0, count: 0 },
      edit: { type: "edit", label: "Edit image", credits: 0, count: 0 },
    };

    for (const j of jobs || []) {
      const credits = Number(j.credits_used) || 0;
      const gen = (j.generate_type || "Normal") as string;
      const hasGlb = !!(j.result_glb_url && String(j.result_glb_url).trim());

      const bucket = map[usageCategory(gen, hasGlb)];
      bucket.credits += credits;
      bucket.count += 1;
    }

    const breakdown = Object.values(map)
      .filter((b) => b.credits > 0)
      .sort((a, b) => b.credits - a.credits);

    res.json({ breakdown });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching usage");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// GET USAGE HISTORY (per-job rows for table / CSV)
// GET /api/payments/usage/history?limit=100
// ============================================================================
paymentsRouter.get("/usage/history", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit), 10) || 100));

    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("id, created_at, generate_type, credits_used, result_glb_url, status")
      .eq("user_id", userId)
      .gt("credits_used", 0)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error({ error: error.message }, "Error fetching usage history");
      return res.status(500).json({ error: "Failed to load usage history" });
    }

    const rows = (jobs || []).map((j) => {
      const gen = (j.generate_type || "Normal") as string;
      const hasGlb = !!(j.result_glb_url && String(j.result_glb_url).trim());
      const label = USAGE_HISTORY_LABELS[usageCategory(gen, hasGlb)];
      return {
        id: j.id,
        date: j.created_at,
        type: label,
        credits: Number(j.credits_used) || 0,
        status: j.status === "DONE" ? "Included" : j.status === "FAIL" ? "Failed" : "Included",
      };
    });

    res.json({ usage: rows });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching usage history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// WEBHOOK ENDPOINT
// POST /api/payments/webhook/dodo
// Handles subscription lifecycle events from Dodo Payments
// ============================================================================
paymentsRouter.post("/webhook/dodo", async (req: Request, res: Response) => {
  try {
    const webhookId = req.headers["webhook-id"] as string;
    const webhookSignature = req.headers["webhook-signature"] as string;
    const webhookTimestamp = req.headers["webhook-timestamp"] as string;

    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      logger.warn("Webhook missing required headers");
      return res.status(400).json({ error: "Missing webhook headers" });
    }

    // --- DEDUPLICATION CHECK ---
    const { data: existingWebhook } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("webhook_id", webhookId)
      .maybeSingle();

    if (existingWebhook) {
      logger.info({ webhookId }, "Webhook already processed");
      return res.status(200).json({ received: true, status: "already_processed" });
    }

    // --- GET RAW PAYLOAD ---
    let payload: string;
    if (Buffer.isBuffer(req.body)) {
      payload = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      payload = req.body;
    } else {
      payload = JSON.stringify(req.body);
    }

    // --- VERIFY SIGNATURE ---
    let event: any;
    try {
      const dodo = getDodoPaymentsClient();
      event = dodo.webhooks.unwrap(payload, {
        headers: {
          "webhook-id": webhookId,
          "webhook-signature": webhookSignature,
          "webhook-timestamp": webhookTimestamp,
        },
      });
      logger.info({ type: event?.type }, "Webhook signature verified");
    } catch (verifyError: any) {
      const isProd =
        process.env.NODE_ENV === "production" ||
        process.env.VERCEL_ENV === "production";
      if (!isProd && process.env.SKIP_WEBHOOK_VERIFICATION === "true") {
        logger.warn("Skipping webhook verification (dev mode only)");
        try { event = JSON.parse(payload); } catch {
          return res.status(400).json({ error: "Invalid JSON payload" });
        }
      } else {
        if (isProd && process.env.SKIP_WEBHOOK_VERIFICATION === "true") {
          logger.error("SKIP_WEBHOOK_VERIFICATION is set but ignored in production");
        }
        logger.error({ error: verifyError?.message }, "Webhook signature verification failed");
        return res.status(401).json({ error: "Signature verification failed" });
      }
    }

    const eventType: string = event?.type || "";
    const eventData: any = event?.data || {};

    // --- STORE WEBHOOK (deduplication) ---
    const { error: insertErr } = await supabase.from("webhook_events").insert({
      webhook_id: webhookId,
      event_type: eventType,
      payload: event,
    });

    if (insertErr?.code === "23505") {
      // Race: another process already stored and processed this exact webhook_id
      logger.info({ webhookId, eventType }, "Webhook already processed (race dedup)");
      return res.status(200).json({ received: true, status: "already_processed" });
    }

    // ── PROCESS BEFORE RESPONDING ─────────────────────────────────────────────
    // On Vercel / serverless hosts the function can be frozen immediately after
    // res.json(), so we process synchronously first, then acknowledge Dodo.
    // DB operations are fast (< 2 s); Dodo's response timeout is ~30 s so this
    // is safe. We ALWAYS return 200 even when a handler throws.
    logger.info({ eventType, webhookId }, "Processing webhook event");

    try {
      switch (eventType) {
        case "subscription.active":
        case "subscription.plan_changed":
          await handleSubscriptionActive(eventData, webhookId);
          break;
        case "subscription.renewed":
          await handleSubscriptionRenewed(eventData, webhookId);
          break;
        case "subscription.cancelled":
        case "subscription.expired":
          await handleSubscriptionCancelled(eventData, eventType);
          break;
        case "subscription.on_hold":
          await handleSubscriptionOnHold(eventData);
          break;
        case "subscription.paused":
          await handleSubscriptionOnHold(eventData);
          await persistSubscriptionStatus(eventData.subscription_id || eventData.id, "paused");
          break;
        case "subscription.failed":
          await handleSubscriptionFailed(eventData);
          break;
        case "subscription.past_due":
          await persistSubscriptionStatus(eventData.subscription_id || eventData.id, "past_due");
          logger.info({ subscriptionId: eventData?.subscription_id }, "Subscription past due; access stays until on_hold or cancelled");
          break;
        case "subscription.unpaused":
          await handleSubscriptionUpdated({ ...eventData, status: "active" });
          break;
        case "subscription.updated":
          await handleSubscriptionUpdated(eventData);
          break;
        case "payment.succeeded":
          await handlePaymentSucceeded(eventData, webhookId);
          break;
        case "payment.failed":
          await handlePaymentFailed(eventData, webhookId);
          break;
        case "refund.succeeded":
        case "payment.refunded":
          await handleRefundSucceeded(eventData, webhookId);
          break;
        case "credit.added":
          await handleCreditAdded(eventData, webhookId);
          break;
        default:
          logger.info({ eventType }, "Unhandled webhook event type – ignored");
      }
    } catch (handlerErr: any) {
      // Log handler errors but ALWAYS return 200 so Dodo does not retry
      logger.error({ eventType, webhookId, error: handlerErr?.message, stack: handlerErr?.stack }, "Webhook handler error");
    }

    // --- ACK DODO AFTER PROCESSING ---
    return res.status(200).json({ received: true, eventType });

  } catch (error: any) {
    logger.error({ error: error?.message, stack: error?.stack }, "Webhook processing error");
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: "Processing error" });
    }
  }
});

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

/** subscription.active - New subscription activated, grant credits */
async function handleSubscriptionActive(data: any, webhookId: string) {
  try {
    const subscriptionId = data.subscription_id || data.id;
    const productId = data.product_id;
    const customerId = data.customer_id;
    const email: string =
      data.customer?.email ||
      data.customer_email ||
      data.email ||
      (typeof data.customer === "string" ? data.customer : "") ||
      "";
    const customerName: string = data.customer?.name || data.customer_name || "";
    const currency: string = data.currency || "INR";
    const currentPeriodStart = data.current_period_start || data.current_period_start_at || data.previous_billing_date;
    const currentPeriodEnd = data.current_period_end || data.current_period_end_at || data.next_billing_date;
    const recurringAmount: number = data.recurring_pre_tax_amount ?? data.recurring_amount ?? 0;

    const plan = resolvePaidPlan(data, productId);
    const credits = plan ? PLAN_CREDITS[plan] : 0;
    if (!plan && (productId || subscriptionId)) {
      logger.info({ subscriptionId, productId }, "subscription.active: unknown product_id, skipping credit grant");
    }

    const callerUserId = nonEmptyString(data._callerUserId);
    const metadataUserId = nonEmptyString(data?.metadata?.user_id);
    const userId: string | null = callerUserId || metadataUserId || (email ? await findUserIdByEmail(email) : null);

    logger.info({ subscriptionId, productId, plan, email, credits, userId }, "Subscription activated");

    if (!userId && !email) {
      logger.error({ data, keys: Object.keys(data || {}) }, "subscription.active missing user_id and customer email");
      return;
    }

    const { data: existingSub } = subscriptionId
      ? await supabase.from("user_subscriptions").select("metadata").eq("dodo_subscription_id", subscriptionId).maybeSingle()
      : { data: null };
    const previousMeta = existingSub?.metadata && typeof existingSub.metadata === "object" ? existingSub.metadata : {};
    const cancelScheduled = data.cancel_at_next_billing_date === true || previousMeta.cancel_at_next_billing_date === true;

    // --- Upsert user_subscriptions (no email column on live table) ---
    logger.info({ subscriptionId, email, plan, userId }, "Upserting user_subscriptions...");
    const { error: subErr } = await writeUserSubscription("upsert", {
      user_id: userId,
      plan: plan || "unknown",
      status: "active",
      dodo_subscription_id: subscriptionId,
      dodo_customer_id: customerId,
      product_id: productId,
      recurring_amount: recurringAmount,
      currency,
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      customer_name: customerName,
      metadata: {
        ...previousMeta,
        webhook_id: webhookId,
        plan: plan || "unknown",
        user_id: userId,
        email,
        cancel_at_next_billing_date: cancelScheduled,
        next_billing_date: data.next_billing_date || previousMeta.next_billing_date || currentPeriodEnd || null,
      },
      updated_at: new Date().toISOString(),
    });

    if (subErr) {
      logger.error({ error: subErr, code: subErr.code, details: subErr.details, hint: subErr.hint, subscriptionId, email, plan, userId }, "❌ Failed to upsert user_subscriptions");
    } else {
      logger.info({ subscriptionId, email, plan, userId }, "✅ user_subscriptions upserted");
    }

    // --- Upsert user_credits ---
    if (plan && credits > 0) {
      await upsertUserCredits({
        userId,
        email,
        plan,
        creditsTotal: credits,
        subscriptionId,
        resetAt: currentPeriodEnd,
      });
    }

    logger.info({ subscriptionId, email, plan, credits }, "✅ Subscription active + credits granted");

    captureServerEvent(userId, "subscription_activated", {
      plan: plan || "unknown",
      credits,
      source: "dodo_webhook",
    });
    void flushPostHog();
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionActive");
  }
}

/** subscription.renewed - Billing cycle renewed, reset credits */
async function handleSubscriptionRenewed(data: any, webhookId: string) {
  try {
    const subscriptionId = data.subscription_id;
    const productId = data.product_id;
    const email: string = data.customer?.email || data.email || "";
    const currentPeriodStart = data.current_period_start || data.previous_billing_date;
    const currentPeriodEnd = data.current_period_end || data.next_billing_date;

    const plan = resolvePaidPlan(data, productId);
    const credits = plan ? PLAN_CREDITS[plan] : 0;

    logger.info({ subscriptionId, plan, email }, "Subscription renewed");

    const renewUpdate: Record<string, unknown> = {
      status: "active",
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString(),
      metadata: { last_renewed: new Date().toISOString(), webhook_id: webhookId, plan: plan || null },
    };
    if (plan) renewUpdate.plan = plan;

    const { error: renewErr } = await writeUserSubscription("update", renewUpdate, subscriptionId);
    if (renewErr) {
      logger.error({ error: renewErr, subscriptionId, plan }, "Failed to update user_subscriptions on renew");
    }

    // Reset credits for new cycle (resolve user_id from subscription, then email from users)
    if (plan && credits > 0) {
      const { data: subRow } = await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("dodo_subscription_id", subscriptionId)
        .maybeSingle();
      const userId = subRow?.user_id ?? (email ? await findUserIdByEmail(email) : null);
      const userEmail = userId
        ? (await supabase.from("users").select("email").eq("id", userId).maybeSingle()).data?.email ?? email
        : email;
      if (userId && userEmail) {
        await upsertUserCredits({
          userId,
          email: userEmail,
          plan,
          creditsTotal: credits,
          subscriptionId,
          resetAt: currentPeriodEnd,
          resetUsed: true,
        });
      }
    }

    logger.info({ subscriptionId, plan, credits }, "✅ Subscription renewed + credits reset");

    const renewUserId =
      (await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("dodo_subscription_id", subscriptionId)
        .maybeSingle()).data?.user_id ??
      (email ? await findUserIdByEmail(email) : null);
    captureServerEvent(renewUserId, "subscription_renewed", {
      plan: plan || "unknown",
      credits,
    });
    void flushPostHog();
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionRenewed");
  }
}

/** subscription.cancelled / subscription.expired. A scheduled cancel stays active until this event. */
async function handleSubscriptionCancelled(data: any, eventType: string) {
  try {
    const subscriptionId = data.subscription_id || data.id;
    if (!subscriptionId) return;
    const stillScheduled = data.cancel_at_next_billing_date === true && data.status === "active";
    if (stillScheduled) {
      await markCancelScheduled(subscriptionId, data);
      return;
    }

    const status = eventType === "subscription.expired" ? "expired" : "cancelled";

    logger.info({ subscriptionId, status }, "Subscription cancelled/expired");

    const { data: existing } = await supabase
      .from("user_subscriptions")
      .select("metadata")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
    const previousMeta = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};

    await supabase
      .from("user_subscriptions")
      .update({
        status,
        cancelled_at: new Date().toISOString(),
        metadata: { ...previousMeta, cancel_at_next_billing_date: false },
        updated_at: new Date().toISOString(),
      })
      .eq("dodo_subscription_id", subscriptionId);

    const { data: subRow } = await supabase
      .from("user_subscriptions")
      .select("user_id, plan")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
    if (subRow?.user_id) {
      await endPaidAccess(subRow.user_id, subscriptionId);
    }
    captureServerEvent(subRow?.user_id, "subscription_cancelled", {
      status,
      plan: subRow?.plan || null,
    });
    void flushPostHog();
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionCancelled");
  }
}

/** subscription.on_hold - Payment failed, subscription paused */
async function handleSubscriptionOnHold(data: any) {
  try {
    const subscriptionId = data.subscription_id;
    logger.info({ subscriptionId }, "Subscription on hold");

    await supabase
      .from("user_subscriptions")
      .update({
        status: "on_hold",
        updated_at: new Date().toISOString(),
      })
      .eq("dodo_subscription_id", subscriptionId);

    const { data: subRow } = await supabase
      .from("user_subscriptions")
      .select("user_id")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
    if (subRow?.user_id) {
      await supabase
        .from("user_credits")
        .update({ plan: null, updated_at: new Date().toISOString() })
        .eq("user_id", subRow.user_id);
    }
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionOnHold");
  }
}

/** subscription.failed */
async function handleSubscriptionFailed(data: any) {
  try {
    const subscriptionId = data.subscription_id;
    logger.info({ subscriptionId }, "Subscription failed");

    await supabase
      .from("user_subscriptions")
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("dodo_subscription_id", subscriptionId);

    const { data: subRow } = await supabase
      .from("user_subscriptions")
      .select("user_id")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
    if (subRow?.user_id) {
      await supabase
        .from("user_credits")
        .update({ plan: null, updated_at: new Date().toISOString() })
        .eq("user_id", subRow.user_id);
    }
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionFailed");
  }
}

/** subscription.updated — sync status and plan. A scheduled cancel does not remove access. */
async function handleSubscriptionUpdated(data: any) {
  try {
    const subscriptionId = data.subscription_id || data.id;
    if (!subscriptionId) return;
    const scheduled = data.cancel_at_next_billing_date === true;
    const rawStatus = typeof data.status === "string" ? data.status : "";
    const status = rawStatus === "paused" ? "on_hold" : rawStatus;

    if (scheduled && (status === "active" || status === "")) {
      await markCancelScheduled(subscriptionId, data);
      return;
    }
    if (status === "cancelled" || status === "expired") {
      await handleSubscriptionCancelled(
        data,
        status === "expired" ? "subscription.expired" : "subscription.cancelled"
      );
      return;
    }

    const allowed = new Set(["pending", "active", "on_hold", "failed"]);
    const plan = resolvePaidPlan(data, data.product_id);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (allowed.has(status)) patch.status = status;
    if (plan) patch.plan = plan;
    const periodStart = data.current_period_start || data.previous_billing_date;
    const periodEnd = data.current_period_end || data.next_billing_date;
    if (periodStart) patch.current_period_start = periodStart;
    if (periodEnd) patch.current_period_end = periodEnd;
    if (data.cancel_at_next_billing_date === false) {
      const { data: existing } = await supabase
        .from("user_subscriptions")
        .select("metadata")
        .eq("dodo_subscription_id", subscriptionId)
        .maybeSingle();
      const previousMeta = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
      patch.metadata = { ...previousMeta, cancel_at_next_billing_date: false };
    }
    const { error } = await writeUserSubscription("update", patch, subscriptionId);
    if (error) logger.error({ error, subscriptionId }, "Failed to apply subscription.updated");
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionUpdated");
  }
}

async function markCancelScheduled(subscriptionId: string, data: any) {
  const { data: existing } = await supabase
    .from("user_subscriptions")
    .select("metadata")
    .eq("dodo_subscription_id", subscriptionId)
    .maybeSingle();
  const previousMeta = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
  const periodEnd = data.current_period_end || data.next_billing_date || previousMeta.next_billing_date || null;
  const patch: Record<string, unknown> = {
    status: "active",
    metadata: {
      ...previousMeta,
      cancel_at_next_billing_date: true,
      next_billing_date: periodEnd,
    },
    updated_at: new Date().toISOString(),
  };
  if (periodEnd) patch.current_period_end = periodEnd;
  const { error } = await writeUserSubscription("update", patch, subscriptionId);
  if (error) logger.error({ error, subscriptionId }, "Failed to store scheduled cancellation");
  else logger.info({ subscriptionId, periodEnd }, "Cancellation scheduled for the next billing date");
}

/** First confirmed payment for this subscription resets usage. Opening the success page again does not. */
async function resetCreditsForNewPaidPeriod(
  userId: string | null,
  data: any,
  before: { subscription_id?: string | null; plan?: string | null; credits_total?: number | null } | null
) {
  if (!userId) return;
  const plan = resolvePaidPlan(data, data.product_id);
  if (!plan) return;
  const alreadyOnThisPlan =
    before?.subscription_id === data.subscription_id &&
    canonicalizePlan(before?.plan) === plan &&
    before?.credits_total === PLAN_CREDITS[plan];
  if (alreadyOnThisPlan) return;
  await upsertUserCredits({
    userId,
    plan,
    creditsTotal: PLAN_CREDITS[plan],
    subscriptionId: data.subscription_id,
    resetAt: data.current_period_end || data.next_billing_date || null,
    resetUsed: true,
  });
}

/** Paid term ended. Plan label goes back to Free and the monthly allotment returns to 100. */
async function endPaidAccess(userId: string, subscriptionId: string) {
  const { data: credits } = await supabase
    .from("user_credits")
    .select("id, subscription_id, plan")
    .eq("user_id", userId)
    .maybeSingle();
  if (!credits) return;
  if (credits.subscription_id && credits.subscription_id !== subscriptionId) return;
  const paid = canonicalizePlan(credits.plan);
  const update: Record<string, unknown> = { plan: null, updated_at: new Date().toISOString() };
  if (paid) {
    update.credits_total = FREE_CREDITS;
    update.credits_used = 0;
    update.subscription_id = null;
    update.reset_at = null;
  }
  const { error } = await supabase.from("user_credits").update(update).eq("id", credits.id);
  if (error) logger.error({ error, userId, subscriptionId }, "Failed to end paid credits");
}

/** refund.succeeded / payment.refunded — mark the existing payment row. Does not delete it. */
async function handleRefundSucceeded(data: any, webhookId: string) {
  try {
    const paymentId = data.payment_id || data.id;
    if (!paymentId) return;
    await recordSubscriptionPayment({
      paymentId,
      subscriptionId: data.subscription_id || null,
      email: data.customer?.email || data.metadata?.email || "",
      userId: data.metadata?.user_id || null,
      amountCents: data.total_amount || data.amount || 0,
      currency: data.currency || "INR",
      status: "refunded",
      plan: resolvePaidPlan(data, data.product_id),
      webhookId,
      metadata: { raw: data },
    });
    logger.info({ paymentId }, "Payment marked refunded");
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleRefundSucceeded");
  }
}

async function recordSubscriptionPayment(params: {
  paymentId: string;
  subscriptionId?: string | null;
  email?: string | null;
  userId?: string | null;
  amountCents?: number;
  currency?: string;
  status: "succeeded" | "failed" | "refunded";
  plan?: string | null;
  webhookId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!params.paymentId) return;
  const { error } = await supabase.from("subscription_payments").upsert(
    {
      email: params.email || null,
      user_id: params.userId || null,
      dodo_payment_id: params.paymentId,
      dodo_subscription_id: params.subscriptionId || null,
      amount_cents: params.amountCents ?? 0,
      currency: params.currency || "INR",
      status: params.status,
      plan: params.plan ? canonicalizePlan(params.plan) || params.plan : null,
      webhook_id: params.webhookId || null,
      metadata: params.metadata || null,
    },
    { onConflict: "dodo_payment_id" }
  );
  if (error) {
    logger.error({ error, paymentId: params.paymentId }, "Failed to upsert subscription_payments");
  }
}

/** payment.succeeded - Log payment record AND activate subscription if not yet active.
 *  This acts as a fallback for when subscription.active webhook can't reach the server
 *  (e.g. localhost). We fetch the subscription from Dodo and run handleSubscriptionActive.
 */
async function handlePaymentSucceeded(data: any, webhookId: string) {
  try {
    const paymentId = data.payment_id || data.id;
    const subscriptionId = data.subscription_id;
    const email: string =
      data.customer?.email ||
      data.metadata?.email ||
      data.email ||
      "";
    const amountCents: number = data.total_amount || data.amount || 0;
    const currency: string = data.currency || "INR";
    // product_cart may be null for subscription payments — determine plan from subscription
    const productId = data.product_cart?.[0]?.product_id || data.product_id;
    let plan = resolvePaidPlan(data, productId);

    logger.info({ paymentId, subscriptionId, email, amountCents, plan }, "Payment succeeded");

    await recordSubscriptionPayment({
      paymentId,
      subscriptionId,
      email,
      userId: data.metadata?.user_id || null,
      amountCents,
      currency,
      status: "succeeded",
      plan,
      webhookId,
      metadata: { raw: data },
    });

    // ── Subscription activation fallback ────────────────────────────────────
    // subscription.active may never reach localhost; activate here if the
    // payment belongs to a subscription and no active row exists yet.
    if (subscriptionId) {
      const { data: existingSub } = await supabase
        .from("user_subscriptions")
        .select("id, status")
        .eq("dodo_subscription_id", subscriptionId)
        .maybeSingle();

      const alreadyActive =
        existingSub?.status === "active" || existingSub?.status === "on_hold";

      if (!alreadyActive) {
        logger.info({ subscriptionId, email }, "payment.succeeded: no active subscription row – fetching from Dodo to activate");
        try {
          const dodo = getDodoPaymentsClient();
          const sub: any = await dodo.subscriptions.retrieve(subscriptionId);
          const customerEmail: string =
            sub.customer?.email || sub.customer_email || email;

          const subData = {
            subscription_id: sub.id || sub.subscription_id || subscriptionId,
            product_id: sub.product_id || productId,
            customer_id: sub.customer_id || data.customer?.customer_id,
            customer: sub.customer || { email: customerEmail },
            email: customerEmail,
            currency: sub.currency || currency,
            current_period_start: sub.current_period_start,
            current_period_end: sub.current_period_end,
            recurring_pre_tax_amount: sub.recurring_pre_tax_amount ?? amountCents,
            metadata: sub.metadata || data.metadata || {},
            _callerUserId: data.metadata?.user_id || null,
          };

          await handleSubscriptionActive(subData, `payment-fallback-${webhookId}`);
          logger.info({ subscriptionId, email }, "✅ Subscription activated via payment.succeeded fallback");
        } catch (fetchErr: any) {
          logger.warn({ err: fetchErr?.message, subscriptionId }, "payment.succeeded: could not fetch subscription from Dodo for fallback activation");
        }
      } else {
        logger.info({ subscriptionId }, "payment.succeeded: subscription already active – skipping fallback");
      }
    }
  } catch (error: any) {
    logger.error({ error: error?.message, stack: error?.stack }, "Error in handlePaymentSucceeded");
  }
}

/** payment.failed - Log failed payment */
async function handlePaymentFailed(data: any, webhookId: string) {
  try {
    const paymentId = data.payment_id || data.id;
    const subscriptionId = data.subscription_id;
    const email: string = data.customer?.email || "";
    const amountCents: number = data.total_amount || data.amount || 0;
    const currency: string = data.currency || "INR";

    logger.info({ paymentId, subscriptionId, email }, "Payment failed");

    await recordSubscriptionPayment({
      paymentId,
      subscriptionId,
      email,
      userId: data.metadata?.user_id || null,
      amountCents,
      currency,
      status: "failed",
      plan: resolvePaidPlan(data, data.product_cart?.[0]?.product_id || data.product_id),
      webhookId,
      metadata: { raw: data },
    });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handlePaymentFailed");
  }
}

/** credit.added - Credits granted (from Dodo Credit-Based Billing); ensure user_credits is set */
async function handleCreditAdded(data: any, webhookId: string) {
  try {
    const subscriptionId = data.subscription_id || data.subscription?.id;
    const customerId = data.customer_id || data.customer?.id;
    const email: string =
      data.customer?.email ||
      data.customer_email ||
      data.email ||
      "";
    const amountIncremental = Number(data.amount ?? data.quantity ?? data.credits_added ?? 0);
    const balanceAfter = data.balance_after != null ? Number(data.balance_after) : null;
    const totalBalance = data.total_balance != null ? Number(data.total_balance) : (data.available_balance != null ? Number(data.available_balance) : null);

    logger.info({ subscriptionId, customerId, email, amountIncremental, balanceAfter, totalBalance, dataKeys: Object.keys(data || {}) }, "Credit added");

    let resolvedEmail = email;
    let plan: string | null = null;

    if (!resolvedEmail && subscriptionId) {
      const { data: sub } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan")
        .eq("dodo_subscription_id", subscriptionId)
        .maybeSingle();
      if (sub?.user_id) {
        plan = sub.plan;
        const { data: user } = await supabase.from("users").select("email").eq("id", sub.user_id).maybeSingle();
        resolvedEmail = user?.email ?? "";
      }
    }

    if (!resolvedEmail) {
      logger.warn({ data }, "credit.added: no email and could not resolve from subscription");
      return;
    }

    const userId = await findUserIdByEmail(resolvedEmail);

    let creditsTotal: number;
    if (totalBalance != null && totalBalance >= 0) {
      creditsTotal = Math.round(totalBalance);
    } else if (balanceAfter != null && balanceAfter >= 0) {
      creditsTotal = Math.round(balanceAfter);
    } else if (amountIncremental > 0) {
      const existing = userId
        ? (await supabase.from("user_credits").select("credits_total, credits_used").eq("user_id", userId).maybeSingle()).data
        : null;
      const currentTotal = existing?.credits_total ?? 0;
      creditsTotal = Math.max(currentTotal, currentTotal + Math.round(amountIncremental));
    } else {
      logger.info({ data }, "credit.added: no usable amount/balance, skipping");
      return;
    }

    if (creditsTotal < 0) {
      logger.info({ creditsTotal, data }, "credit.added: negative total, skipping");
      return;
    }

    await upsertUserCredits({
      userId,
      email: resolvedEmail,
      plan: canonicalizePlan(plan) || "starter",
      creditsTotal,
      subscriptionId: subscriptionId || "",
      resetAt: data.reset_at || data.period_end || undefined,
    });

    logger.info({ email: resolvedEmail, creditsTotal, subscriptionId }, "✅ credit.added applied to user_credits");
  } catch (error: any) {
    logger.error({ error: error?.message, stack: error?.stack }, "Error in handleCreditAdded");
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const BILLING_PAYMENT_COLUMNS =
  "id, created_at, amount_cents, currency, status, plan, dodo_payment_id, dodo_subscription_id, email, user_id";

/** Every charge for this person: the signed-in id, every Clerk id with the same email, and rows saved only by email. */
async function listPaymentsForPerson(userId: string) {
  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (meErr) throw meErr;

  const email = (me?.email || "").trim();
  const { data: samePerson } = email
    ? await supabase.from("users").select("id").eq("email", email)
    : { data: [] as { id: string }[] };
  const userIds = Array.from(new Set([userId, ...(samePerson || []).map((row) => row.id).filter(Boolean)]));

  const [byUser, byEmail] = await Promise.all([
    supabase
      .from("subscription_payments")
      .select(BILLING_PAYMENT_COLUMNS)
      .in("user_id", userIds)
      .order("created_at", { ascending: false })
      .limit(100),
    email
      ? supabase
          .from("subscription_payments")
          .select(BILLING_PAYMENT_COLUMNS)
          .eq("email", email)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (byUser.error) throw byUser.error;
  if (byEmail.error) throw byEmail.error;

  const merged = new Map<string, any>();
  for (const row of [...(byEmail.data || []), ...(byUser.data || [])]) {
    merged.set(row.id, row);
  }
  const rows = Array.from(merged.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const missingPlanSubs = Array.from(
    new Set(
      rows
        .filter((row) => !row.plan && row.dodo_subscription_id)
        .map((row) => row.dodo_subscription_id as string)
    )
  );
  const planBySubscription = new Map<string, string>();
  if (missingPlanSubs.length) {
    const { data: subs } = await supabase
      .from("user_subscriptions")
      .select("dodo_subscription_id, plan")
      .in("dodo_subscription_id", missingPlanSubs);
    for (const sub of subs || []) {
      if (sub.dodo_subscription_id && sub.plan) planBySubscription.set(sub.dodo_subscription_id, sub.plan);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    amount: row.amount_cents ?? 0,
    currency: row.currency || "INR",
    status: row.status,
    plan: row.plan || planBySubscription.get(row.dodo_subscription_id) || null,
    paymentId: row.dodo_payment_id,
  }));
}

/** Find a Clerk user_id by email from the users table */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    logger.warn({ error: error.message }, "findUserIdByEmail failed");
    return null;
  }
  return data?.[0]?.id || null;
}

/** Upsert user_credits by user_id only (no email). */
async function upsertUserCredits(params: {
  userId: string | null;
  email?: string;
  plan: string;
  creditsTotal: number;
  subscriptionId?: string | null;
  resetAt?: string | null;
  resetUsed?: boolean;
}) {
  const { userId, plan, creditsTotal, subscriptionId, resetAt, resetUsed } = params;
  const subId = subscriptionId && subscriptionId.trim() ? subscriptionId.trim() : null;

  if (!userId) {
    logger.error({}, "upsertUserCredits called without userId – skipping");
    return;
  }

  const { data: existing, error: selectErr } = await supabase
    .from("user_credits")
    .select("id, credits_used")
    .eq("user_id", userId)
    .maybeSingle();

  if (selectErr) {
    logger.error({ error: selectErr, userId }, "user_credits select failed");
    return;
  }

  if (existing) {
    const updateData: Record<string, unknown> = {
      plan,
      credits_total: creditsTotal,
      credits_used: resetUsed ? 0 : existing.credits_used,
      reset_at: resetAt || null,
      updated_at: new Date().toISOString(),
    };
    if (subId) updateData.subscription_id = subId;

    const { error: updateErr } = await supabase.from("user_credits").update(updateData).eq("id", existing.id);
    if (updateErr) logger.error({ error: updateErr, userId }, "user_credits update failed");
    else logger.info({ userId, plan, creditsTotal }, "user_credits updated");
  } else {
    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      plan,
      credits_total: creditsTotal,
      credits_used: 0,
      reset_at: resetAt || null,
    };
    if (subId) insertPayload.subscription_id = subId;

    const { error: insertErr } = await supabase.from("user_credits").insert(insertPayload);
    if (insertErr) {
      if (insertErr.code === "23505") {
        const { data: raceRow } = await supabase.from("user_credits").select("id, credits_used").eq("user_id", userId).maybeSingle();
        if (raceRow) {
          const retryData: Record<string, unknown> = {
            plan,
            credits_total: creditsTotal,
            credits_used: resetUsed ? 0 : raceRow.credits_used,
            reset_at: resetAt || null,
            updated_at: new Date().toISOString(),
          };
          if (subId) retryData.subscription_id = subId;
          await supabase.from("user_credits").update(retryData).eq("id", raceRow.id);
        }
      } else {
        logger.error({ error: insertErr, userId }, "user_credits insert failed");
      }
    } else {
      logger.info({ userId, plan, creditsTotal }, "user_credits inserted (new row)");
    }
  }
}
