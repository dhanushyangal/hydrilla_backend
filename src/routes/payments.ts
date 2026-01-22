import { Router, Request, Response } from "express";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { optionalAuth } from "../middleware/auth.js";
import DodoPayments from "dodopayments";

// ============================================================================
// DODO PAYMENTS INTEGRATION - Clean Implementation
// ============================================================================
// Features:
// 1. Webhook deduplication using webhook_id
// 2. One-time access per email (DB enforced)
// 3. Payment ID tracking (unique constraint)
// 4. Pre-checkout access check (best UX)
// ============================================================================

// Initialize DodoPayments client for webhook verification
const dodoClient = new DodoPayments({
  bearerToken: config.dodoPayment.apiKey,
  environment: config.dodoPayment.mode === "live" ? "live_mode" : "test_mode",
  webhookKey: config.dodoPayment.webhookSecret,
});

export const paymentsRouter = Router();

// ============================================================================
// CORS MIDDLEWARE
// ============================================================================
paymentsRouter.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  
  next();
});

// ============================================================================
// TEST ENDPOINT
// ============================================================================
paymentsRouter.get("/test", (_req: Request, res: Response) => {
  res.json({ 
    message: "Payments router is working",
    timestamp: new Date().toISOString(),
    config: {
      hasApiKey: !!config.dodoPayment.apiKey,
      hasProductId: !!config.dodoPayment.productId,
      hasWebhookSecret: !!config.dodoPayment.webhookSecret,
      mode: config.dodoPayment.mode,
    }
  });
});

// ============================================================================
// CHECK EARLY ACCESS STATUS
// GET /api/payments/early-access/check
// ============================================================================
paymentsRouter.get("/early-access/check", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const email = req.query.email as string;

    if (!userId && !email) {
      return res.json({ hasAccess: false, accessInfo: null });
    }

    // Check in early_access table (new schema)
    let query = supabase
      .from("early_access")
      .select("*")
      .eq("status", "granted");

    if (email) {
      query = query.eq("email", email);
    } else if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data: access, error } = await query.maybeSingle();

    if (error) {
      logger.error({ error }, "Error checking early access");
      return res.status(500).json({ error: "Database error" });
    }

    res.json({
      hasAccess: !!access,
      accessInfo: access || null,
    });
  } catch (error: any) {
    logger.error({ error }, "Error checking early access");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// CREATE CHECKOUT SESSION (with pre-check)
// POST /api/payments/early-access/create
// ============================================================================
paymentsRouter.post("/early-access/create", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const userId = (req as any).userId || null;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    // ========================================
    // PRE-CHECK: Does email already have access?
    // This prevents showing checkout to users who already paid
    // ========================================
    try {
      const { data: existingAccess, error: checkError } = await supabase
        .from("early_access")
        .select("id, email, granted_at, status")
        .eq("email", email)
        .eq("status", "granted")
        .maybeSingle();

      if (checkError) {
        // Table might not exist - log and continue to checkout
        logger.warn({ checkError, email }, "Error checking early_access - table might not exist, continuing to checkout");
      } else if (existingAccess) {
        logger.info({ 
          email, 
          accessId: existingAccess.id,
          grantedAt: existingAccess.granted_at 
        }, "User already has early access - blocking checkout");
        
        return res.status(409).json({ 
          error: "ALREADY_HAS_ACCESS",
          message: "This email already has early access",
          accessInfo: existingAccess,
          status: "ALREADY_HAS_ACCESS"
        });
      }
    } catch (checkErr) {
      logger.warn({ checkErr, email }, "Exception checking early access - continuing to checkout");
    }

    // Also check by user_id if provided
    if (userId) {
      try {
        const { data: existingByUserId, error: userIdCheckError } = await supabase
          .from("early_access")
          .select("id, email, granted_at")
          .eq("user_id", userId)
          .eq("status", "granted")
          .maybeSingle();

        if (userIdCheckError) {
          logger.warn({ userIdCheckError, userId }, "Error checking by user_id - continuing");
        } else if (existingByUserId) {
          logger.info({ userId, email, accessId: existingByUserId.id }, "User already has access by user_id");
          
          return res.status(409).json({ 
            error: "ALREADY_HAS_ACCESS",
            message: "You already have early access",
            accessInfo: existingByUserId,
            status: "ALREADY_HAS_ACCESS"
          });
        }
      } catch (userCheckErr) {
        logger.warn({ userCheckErr, userId }, "Exception checking by user_id - continuing");
      }
    }

    // ========================================
    // CREATE CHECKOUT SESSION
    // ========================================
    if (!config.dodoPayment.productId) {
      logger.error("DODO_PAYMENT_PRODUCT_ID is not configured");
      return res.status(500).json({ error: "Payment product not configured" });
    }

    const checkoutSession = await createCheckoutSession({
      email,
      userId,
    });

    if (!checkoutSession) {
      logger.error("Failed to create checkout session");
      return res.status(500).json({ error: "Failed to create checkout session" });
    }

    // Log the attempt (for audit)
    try {
      await supabase.from("payment_attempts").insert({
        email,
        user_id: userId,
        checkout_session_id: checkoutSession.session_id,
        status: "pending",
        metadata: { created_at: new Date().toISOString() }
      });
    } catch (err) {
      logger.warn({ err }, "Failed to log payment attempt");
    }

    res.json({
      paymentLink: checkoutSession.checkout_url,
      sessionId: checkoutSession.session_id,
      status: "checkout_created",
    });
  } catch (error: any) {
    logger.error({ error }, "Error creating payment link");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// WEBHOOK ENDPOINT
// POST /api/payments/webhook/dodo
// ============================================================================
paymentsRouter.post("/webhook/dodo", async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // ========================================
    // STEP 1: Extract webhook headers
    // ========================================
    const webhookId = req.headers["webhook-id"] as string;
    const webhookSignature = req.headers["webhook-signature"] as string;
    const webhookTimestamp = req.headers["webhook-timestamp"] as string;

    logger.info({ 
      webhookId,
      hasSignature: !!webhookSignature,
      hasTimestamp: !!webhookTimestamp,
    }, "📥 Webhook received");

    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      logger.warn("Missing webhook headers");
      return res.status(401).json({ error: "Missing webhook headers" });
    }

    // ========================================
    // STEP 2: Check if webhook already processed (DEDUPLICATION)
    // ========================================
    const { data: existingWebhook } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("webhook_id", webhookId)
      .maybeSingle();

    if (existingWebhook) {
      logger.info({ webhookId }, "⏭️ Webhook already processed - returning 200");
      return res.status(200).json({ received: true, status: "already_processed" });
    }

    // ========================================
    // STEP 3: Get raw payload for verification
    // ========================================
    let payload: string;
    if (Buffer.isBuffer(req.body)) {
      payload = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      payload = req.body;
    } else {
      payload = JSON.stringify(req.body);
    }

    // ========================================
    // STEP 4: Verify signature using DodoPayments SDK
    // ========================================
    let event: any;
    try {
      event = dodoClient.webhooks.unwrap(payload, {
        headers: {
          "webhook-id": webhookId,
          "webhook-signature": webhookSignature,
          "webhook-timestamp": webhookTimestamp,
        }
      });
      
      logger.info({ eventType: event?.type }, "✅ Signature verified");
    } catch (verifyError: any) {
      logger.error({ error: verifyError?.message }, "❌ Signature verification failed");
      
      // Allow bypass for testing only
      if (process.env.SKIP_WEBHOOK_VERIFICATION === "true") {
        logger.warn("⚠️ SKIPPING VERIFICATION (testing only)");
        try {
          event = JSON.parse(payload);
        } catch {
          return res.status(400).json({ error: "Invalid JSON" });
        }
      } else {
        return res.status(401).json({ error: "Signature verification failed" });
      }
    }

    const eventType = event?.type || event?.event_type;
    const eventData = event?.data || event;

    // ========================================
    // STEP 5: Store webhook event (for deduplication)
    // ========================================
    const { error: insertWebhookError } = await supabase
      .from("webhook_events")
      .insert({
        webhook_id: webhookId,
        event_type: eventType,
        payload: event,
      });

    if (insertWebhookError) {
      // If unique violation, another process handled it
      if (insertWebhookError.code === '23505') {
        logger.info({ webhookId }, "⏭️ Webhook inserted by another process");
        return res.status(200).json({ received: true, status: "already_processed" });
      }
      logger.error({ error: insertWebhookError }, "Failed to store webhook event");
    }

    // ========================================
    // STEP 6: Respond 200 immediately (Dodo expects quick response)
    // ========================================
    res.status(200).json({ received: true });

    // ========================================
    // STEP 7: Process event asynchronously
    // ========================================
    const processingTime = Date.now() - startTime;
    logger.info({ eventType, processingTime }, "Processing webhook event");

    switch (eventType) {
      case "payment.succeeded":
      case "payment.completed":
        await handlePaymentSuccess(eventData, webhookId);
        break;
      case "payment.failed":
        await handlePaymentFailure(eventData, webhookId);
        break;
      case "refund.succeeded":
        await handleRefund(eventData, webhookId);
        break;
      default:
        logger.info({ eventType }, "Unhandled event type");
    }

    return;
  } catch (error: any) {
    logger.error({ error, stack: error?.stack }, "Webhook processing error");
    // Still return 200 to prevent retries for server errors
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: "Processing error" });
    }
  }
});

// ============================================================================
// GET ACCESS INFO BY ID
// GET /api/payments/early-access/:id
// ============================================================================
paymentsRouter.get("/early-access/:id", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const { data: access, error } = await supabase
      .from("early_access")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !access) {
      return res.status(404).json({ error: "Access record not found" });
    }

    res.json(access);
  } catch (error: any) {
    logger.error({ error }, "Error fetching access info");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// HELPER: Create Dodo Checkout Session
// ============================================================================
async function createCheckoutSession(params: {
  email: string;
  userId?: string | null;
}): Promise<{ checkout_url: string; session_id: string } | null> {
  try {
    const { email, userId } = params;

    const apiUrl = `${config.dodoPayment.baseUrl}/checkouts`;
    
    const returnUrl = config.dodoPayment.returnUrl || 
      (config.email.frontendUrl ? `${config.email.frontendUrl}/checkout/success` : "https://hydrilla.ai/checkout/success");
    
    const payload = {
      product_cart: [
        {
          product_id: config.dodoPayment.productId,
          quantity: 1,
        }
      ],
      customer: {
        email: email,
      },
      return_url: returnUrl,
      metadata: {
        product: "early_access",
        user_id: userId || null,
        email: email,
        created_at: new Date().toISOString(),
      },
      // Include UPI, cards, and other popular payment methods
      allowed_payment_method_types: [
        "credit", 
        "debit", 
        "upi_collect",   // UPI - collect via VPA
        "upi_intent",    // UPI - intent based
        "google_pay",    // Google Pay
        "apple_pay",     // Apple Pay
        "paypal",        // PayPal
      ],
    };

    logger.info({ apiUrl, returnUrl, email }, "Creating checkout session");

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.dodoPayment.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, error: errorText }, "Checkout creation failed");
      return null;
    }

    const data = await response.json();
    
    logger.info({ session_id: data.session_id }, "Checkout session created");
    
    return {
      checkout_url: data.checkout_url,
      session_id: data.session_id,
    };
  } catch (error: any) {
    logger.error({ error }, "Error creating checkout session");
    return null;
  }
}

// ============================================================================
// HANDLER: Payment Success
// ============================================================================
async function handlePaymentSuccess(data: any, webhookId: string) {
  try {
    const paymentId = data.payment_id || data.id;
    const email = data.customer?.email || data.customer_email || data.email;
    const customerName = data.customer?.name || data.customer_name;
    const checkoutSessionId = data.checkout_session_id;
    const userId = data.metadata?.user_id || null;
    
    // Amount handling (Dodo sends in cents)
    const amountCents = data.total_amount || data.amount || 0;
    const amount = typeof amountCents === 'number' ? amountCents / 100 : parseFloat(amountCents) / 100;
    const currency = data.currency || "USD";

    logger.info({ 
      paymentId, 
      email, 
      customerName,
      amountCents,
      webhookId 
    }, "Processing payment success");

    if (!email) {
      logger.error({ data }, "Payment success missing email");
      return;
    }

    // ========================================
    // TRY TO GRANT ACCESS (DB handles uniqueness)
    // ========================================
    const { data: insertResult, error: insertError } = await supabase
      .from("early_access")
      .insert({
        email,
        user_id: userId,
        customer_name: customerName,
        payment_id: paymentId,
        checkout_session_id: checkoutSessionId,
        status: "granted",
        amount,
        amount_cents: amountCents,
        currency,
        webhook_id: webhookId,
        metadata: {
          payment_data: data,
          processed_at: new Date().toISOString(),
        }
      })
      .select()
      .single();

    if (insertError) {
      // Check if it's a duplicate (unique constraint violation)
      if (insertError.code === '23505') {
        logger.info({ 
          email, 
          paymentId,
          errorCode: insertError.code 
        }, "🚫 Email already has access (DB constraint) - this is expected for duplicates");
        
        // Update payment attempt as duplicate
        try {
          await supabase.from("payment_attempts").insert({
            email,
            user_id: userId,
            payment_id: paymentId,
            status: "duplicate_blocked",
            amount_cents: amountCents,
            currency,
            webhook_id: webhookId,
            metadata: { reason: "Email already has access" }
          });
        } catch { /* ignore */ }
        
        return;
      }
      
      logger.error({ error: insertError, email }, "Failed to grant access");
      return;
    }

    logger.info({ 
      accessId: insertResult.id,
      email,
      paymentId,
      status: "ACCESS_GRANTED"
    }, "✅ Early access granted successfully!");

    // Update payment attempt status
    try {
      await supabase.from("payment_attempts")
        .update({ 
          status: "succeeded", 
          payment_id: paymentId,
          updated_at: new Date().toISOString() 
        })
        .eq("email", email)
        .eq("status", "pending");
    } catch { /* ignore */ }

  } catch (error: any) {
    logger.error({ error }, "Error handling payment success");
  }
}

// ============================================================================
// HANDLER: Payment Failure
// ============================================================================
async function handlePaymentFailure(data: any, webhookId: string) {
  try {
    const email = data.customer?.email || data.customer_email || data.email;
    const paymentId = data.payment_id || data.id;
    const errorMessage = data.error?.message || data.failure_reason || "Unknown error";

    logger.info({ email, paymentId, errorMessage }, "Processing payment failure");

    // Log failed attempt
    try {
      await supabase.from("payment_attempts").insert({
        email,
        payment_id: paymentId,
        status: "failed",
        error_message: errorMessage,
        webhook_id: webhookId,
        metadata: data
      });
    } catch { /* ignore */ }

  } catch (error: any) {
    logger.error({ error }, "Error handling payment failure");
  }
}

// ============================================================================
// HANDLER: Refund
// ============================================================================
async function handleRefund(data: any, webhookId: string) {
  try {
    const paymentId = data.payment_id || data.metadata?.payment_id;
    const email = data.customer?.email || data.email;

    logger.info({ paymentId, email }, "Processing refund");

    if (paymentId) {
      // Revoke access by payment_id
      const { data: existing } = await supabase
        .from("early_access")
        .select("metadata")
        .eq("payment_id", paymentId)
        .maybeSingle();
      
      await supabase
        .from("early_access")
        .update({ 
          status: "refunded",
          updated_at: new Date().toISOString(),
          metadata: {
            ...(existing?.metadata || {}),
            refund_webhook_id: webhookId,
            refunded_at: new Date().toISOString()
          }
        })
        .eq("payment_id", paymentId);
    } else if (email) {
      // Revoke access by email
      await supabase
        .from("early_access")
        .update({ 
          status: "refunded",
          updated_at: new Date().toISOString()
        })
        .eq("email", email)
        .eq("status", "granted");
    }

    logger.info({ paymentId, email }, "Access revoked due to refund");
  } catch (error: any) {
    logger.error({ error }, "Error handling refund");
  }
}
