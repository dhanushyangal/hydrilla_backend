import { Router, Request, Response } from "express";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getDodoPaymentsClient } from "../lib/dodopayments.js";
import { captureServerEvent, flushPostHog } from "../lib/posthog.js";

// ============================================================================
// DODO PAYMENTS - Subscription Integration
// Plans: creator (1000 credits/mo), studio (4000 credits/mo)
// Webhook: POST /api/payments/webhook/dodo
// ============================================================================

export const paymentsRouter = Router();

// ============================================================================
// HELPERS
// ============================================================================

/** Get the plan name ('creator' | 'studio') from a Dodo product_id */
function getPlanFromProductId(productId: string): "creator" | "studio" | null {
  if (productId === config.dodoPayment.creatorProductId) return "creator";
  if (productId === config.dodoPayment.studioProductId) return "studio";
  return null;
}

/** Credits granted per plan per billing cycle */
const PLAN_CREDITS: Record<string, number> = {
  creator: 1000,
  studio: 4000,
};

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
    creatorProductId: config.dodoPayment.creatorProductId || "(not set)",
    studioProductId: config.dodoPayment.studioProductId || "(not set)",
  });
});

// ============================================================================
// CREATE SUBSCRIPTION CHECKOUT SESSION
// POST /api/payments/create-checkout
// Body: { plan: "creator" | "studio", email: string }
// ============================================================================
paymentsRouter.post("/create-checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    // Validate early so invalid requests fail fast (better TTFB for client)
    const { plan, email } = req.body ?? {};
    const userId = (req as any).userId || null;

    if (!plan || !["creator", "studio"].includes(plan)) {
      return res.status(400).json({ error: "plan must be 'creator' or 'studio'" });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const productId = plan === "creator"
      ? config.dodoPayment.creatorProductId
      : config.dodoPayment.studioProductId;

    if (!productId) {
      logger.error({ plan }, "Product ID not configured for plan");
      return res.status(500).json({ error: `Payment product for ${plan} plan not configured` });
    }

    const returnUrl = config.dodoPayment.returnUrl ||
      `${config.email.frontendUrl}/checkout/success`;

    const dodo = getDodoPaymentsClient();

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email },
      return_url: returnUrl,
      metadata: {
        plan,
        user_id: userId || "",
        email,
      },
    });

    logger.info({ plan, email, sessionId: session.session_id }, "Checkout session created");

    captureServerEvent(userId, "checkout_session_created", {
      plan,
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

    let subscription = (await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .in("status", ["active", "on_hold"])
      .order("created_at", { ascending: false })
      .maybeSingle()).data;

    res.json({ subscription: subscription || null });
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error fetching subscription");
    res.status(500).json({ error: "Internal server error" });
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

    const dodo = getDodoPaymentsClient();

    if (paymentId && !subscriptionId) {
      try {
        const payment: any = await dodo.payments.retrieve(paymentId);
        subscriptionId = payment.subscription_id || payment.subscription?.id;
        logger.info({ paymentId, subscriptionId }, "Resolved subscription_id from payment_id");
      } catch (err: any) {
        logger.warn({ paymentId, err: err?.message }, "Could not fetch payment from Dodo");
        // Don't 400 — if there's a subscription_id in the query, we'll still use it
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

    // Map Dodo API response to the shape expected by handleSubscriptionActive
    const customerEmail: string =
      sub.customer?.email || sub.customer_email || sub.email || "";
    const data = {
      subscription_id: sub.id || sub.subscription_id,
      product_id: sub.product_id,
      customer_id: sub.customer_id,
      customer: sub.customer || { email: customerEmail, name: sub.customer_name },
      email: customerEmail,
      currency: sub.currency || "INR",
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      recurring_pre_tax_amount: sub.recurring_pre_tax_amount ?? 0,
      // Pass caller's userId so backfill happens in the same call
      _callerUserId: callerUserId,
    };

    await handleSubscriptionActive(data, `sync-${Date.now()}`);

    logger.info({ subscriptionId: data.subscription_id, callerUserId }, "Sync completed – subscription and credits updated in DB");

    res.json({ ok: true, message: "Subscription synced to database", subscription_id: data.subscription_id });
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

    if (!credits) {
      logger.info({ userId }, "No credits row – creating free tier (200 credits)");
      const { data: newRow, error: insertErr } = await supabase
        .from("user_credits")
        .insert({
          user_id: userId,
          plan: null,
          credits_total: 200,
          credits_used: 0,
        })
        .select()
        .single();
      if (!insertErr && newRow) credits = newRow;
      else if (insertErr?.code === "23505") credits = (await supabase.from("user_credits").select("*").eq("user_id", userId).maybeSingle()).data;
      else if (insertErr) logger.error({ error: insertErr, userId }, "Failed to create free credits row");
    }

    if (!credits) {
      // Fallback: return default free-tier values (do not error)
      return res.json({ credits: { used: 0, total: 200, plan: null, remaining: 200 } });
    }

    res.json({
      credits: {
        used: credits.credits_used,
        total: credits.credits_total,
        remaining: Math.max(0, credits.credits_total - credits.credits_used),
        plan: credits.plan,
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
// Returns credits used per category (3D, image gen, edit, combined) from jobs table.
// ============================================================================
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
      combined: { type: "combined", label: "Combine images", credits: 0, count: 0 },
    };

    for (const j of jobs || []) {
      const credits = Number(j.credits_used) || 0;
      const gen = (j.generate_type || "Normal") as string;
      const hasGlb = !!(j.result_glb_url && String(j.result_glb_url).trim());

      if (gen === "EditImage") {
        map.edit.credits += credits;
        map.edit.count += 1;
      } else if (gen === "Combined") {
        map.combined.credits += credits;
        map.combined.count += 1;
      } else if (gen === "Normal" && hasGlb) {
        map["3d"].credits += credits;
        map["3d"].count += 1;
      } else {
        map.image.credits += credits;
        map.image.count += 1;
      }
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
      let label = "Image generation";
      if (gen === "EditImage") label = "Edit image";
      else if (gen === "Combined") label = "Combine images";
      else if (gen === "Normal" && hasGlb) label = "3D model";
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
        case "subscription.failed":
          await handleSubscriptionFailed(eventData);
          break;
        case "payment.succeeded":
          await handlePaymentSucceeded(eventData, webhookId);
          break;
        case "payment.failed":
          await handlePaymentFailed(eventData, webhookId);
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
    const currentPeriodStart = data.current_period_start || data.current_period_start_at;
    const currentPeriodEnd = data.current_period_end || data.current_period_end_at;
    const recurringAmount: number = data.recurring_pre_tax_amount ?? data.recurring_amount ?? 0;

    let plan = getPlanFromProductId(productId);
    let credits = plan ? PLAN_CREDITS[plan] : 0;
    if (!plan && (productId || subscriptionId)) {
      plan = "creator";
      credits = PLAN_CREDITS.creator;
      logger.info({ subscriptionId, productId }, "subscription.active: unknown product_id, defaulting to creator/1000");
    }

    logger.info({ subscriptionId, productId, plan, email, credits }, "Subscription activated");

    if (!email) {
      logger.error({ data, keys: Object.keys(data || {}) }, "subscription.active missing customer email");
      return;
    }

    // --- Find user by email (prefer caller's userId if sync passed it) ---
    const userId: string | null = (data._callerUserId as string | null) || await findUserIdByEmail(email);

    // --- Upsert user_subscriptions ---
    logger.info({ subscriptionId, email, plan, userId }, "Upserting user_subscriptions...");
    const { error: subErr } = await supabase.from("user_subscriptions").upsert(
      {
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
        metadata: { webhook_id: webhookId, raw: data },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "dodo_subscription_id" }
    );

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
    const currentPeriodStart = data.current_period_start;
    const currentPeriodEnd = data.current_period_end;

    const plan = getPlanFromProductId(productId);
    const credits = plan ? PLAN_CREDITS[plan] : 0;

    logger.info({ subscriptionId, plan, email }, "Subscription renewed");

    // Update subscription period
    await supabase
      .from("user_subscriptions")
      .update({
        status: "active",
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        updated_at: new Date().toISOString(),
        metadata: { last_renewed: new Date().toISOString(), webhook_id: webhookId },
      })
      .eq("dodo_subscription_id", subscriptionId);

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

/** subscription.cancelled / subscription.expired */
async function handleSubscriptionCancelled(data: any, eventType: string) {
  try {
    const subscriptionId = data.subscription_id;
    const status = eventType === "subscription.expired" ? "expired" : "cancelled";

    logger.info({ subscriptionId, status }, "Subscription cancelled/expired");

    await supabase
      .from("user_subscriptions")
      .update({
        status,
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("dodo_subscription_id", subscriptionId);

    // Optionally zero out credits on cancellation
    // (We leave existing credits until the end of the period)
    logger.info({ subscriptionId }, `✅ Subscription marked as ${status}`);

    const { data: subRow } = await supabase
      .from("user_subscriptions")
      .select("user_id, plan")
      .eq("dodo_subscription_id", subscriptionId)
      .maybeSingle();
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
  } catch (error: any) {
    logger.error({ error: error?.message }, "Error in handleSubscriptionFailed");
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
    let plan = productId ? getPlanFromProductId(productId) : null;

    logger.info({ paymentId, subscriptionId, email, amountCents, plan }, "Payment succeeded");

    // Store payment record (upsert so replaying is safe)
    await supabase.from("subscription_payments").upsert(
      {
        email,
        user_id: data.metadata?.user_id || null,
        dodo_payment_id: paymentId,
        dodo_subscription_id: subscriptionId,
        amount_cents: amountCents,
        currency,
        status: "succeeded",
        plan,
        webhook_id: webhookId,
        metadata: { raw: data },
      },
      { onConflict: "dodo_payment_id" }
    );

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

    await supabase.from("subscription_payments").upsert(
      {
        email,
        dodo_payment_id: paymentId,
        dodo_subscription_id: subscriptionId,
        amount_cents: amountCents,
        currency,
        status: "failed",
        webhook_id: webhookId,
        metadata: { raw: data },
      },
      { onConflict: "dodo_payment_id" }
    );
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
      plan: plan || "creator",
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

/** Find a Clerk user_id by email from the users table */
async function findUserIdByEmail(email: string): Promise<string | null> {
  try {
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    return user?.id || null;
  } catch {
    return null;
  }
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
