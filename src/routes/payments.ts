import { Router, Request, Response } from "express";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import crypto from "crypto";

export const paymentsRouter = Router();

// CORS middleware
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

// Test endpoint to verify payments router is working
paymentsRouter.get("/test", (_req: Request, res: Response) => {
  res.json({ 
    message: "Payments router is working",
    timestamp: new Date().toISOString(),
    config: {
      hasApiKey: !!config.dodoPayment.apiKey,
      hasProductId: !!config.dodoPayment.productId,
      mode: config.dodoPayment.mode,
      baseUrl: config.dodoPayment.baseUrl,
    }
  });
});

/**
 * Manual sync endpoint to process missed payments from Dodo Payment API
 * POST /api/payments/sync/:paymentId
 * This endpoint manually fetches payment from Dodo and processes it
 */
paymentsRouter.post("/sync/:paymentId", async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    
    if (!paymentId) {
      return res.status(400).json({ error: "Payment ID is required" });
    }

    logger.info({ paymentId }, "Manual payment sync requested");

    // Fetch payment from Dodo Payment API
    const apiUrl = `${config.dodoPayment.baseUrl}/payments/${paymentId}`;
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${config.dodoPayment.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ paymentId, status: response.status, error: errorText }, "Failed to fetch payment from Dodo");
      return res.status(response.status).json({ error: "Failed to fetch payment from Dodo Payment API" });
    }

    const paymentData = await response.json();
    logger.info({ paymentId, status: paymentData.status }, "Fetched payment from Dodo API");

    // Process payment based on status
    if (paymentData.status === "succeeded" || paymentData.status === "completed") {
      // Transform Dodo Payment API response to webhook format
      const webhookData = {
        payment_id: paymentData.payment_id,
        customer: paymentData.customer,
        total_amount: paymentData.total_amount,
        amount: paymentData.total_amount,
        currency: paymentData.currency,
        status: paymentData.status,
        checkout_session_id: paymentData.checkout_session_id,
        metadata: paymentData.metadata,
        ...paymentData
      };

      await handlePaymentSuccess(webhookData);
      
      return res.json({ 
        success: true,
        message: "Payment processed successfully",
        paymentId: paymentData.payment_id,
        email: paymentData.customer?.email
      });
    } else if (paymentData.status === "failed") {
      const webhookData = {
        payment_id: paymentData.payment_id,
        customer: paymentData.customer,
        ...paymentData
      };
      
      await handlePaymentFailure(webhookData);
      
      return res.json({ 
        success: true,
        message: "Payment failure processed",
        paymentId: paymentData.payment_id
      });
    } else {
      return res.json({ 
        success: false,
        message: `Payment status is ${paymentData.status}, not processing`,
        paymentId: paymentData.payment_id,
        status: paymentData.status
      });
    }
  } catch (error: any) {
    logger.error({ error }, "Error in manual payment sync");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Check if user has early access (paid)
 * GET /api/payments/early-access/check
 */
paymentsRouter.get("/early-access/check", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const email = req.query.email as string;

    if (!userId && !email) {
      return res.json({ hasAccess: false, payment: null });
    }

    let query = supabase
      .from("early_access_payments")
      .select("*")
      .eq("payment_status", "completed");

    if (userId) {
      query = query.eq("user_id", userId);
    } else if (email) {
      query = query.eq("email", email);
    }

    const { data: payment } = await query.maybeSingle();

    res.json({
      hasAccess: !!payment,
      payment: payment || null,
    });
  } catch (error: any) {
    logger.error({ error }, "Error checking early access");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Create a payment link for early access
 * POST /api/payments/early-access/create
 */
paymentsRouter.post("/early-access/create", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const userId = (req as any).userId || null;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    // CRITICAL: Check if email already has completed payment (ONE PER EMAIL ENFORCEMENT)
    // This check happens BEFORE creating any payment record
    const { data: existingCompleted } = await supabase
      .from("early_access_payments")
      .select("*")
      .eq("email", email)
      .eq("payment_status", "completed")
      .maybeSingle();

    if (existingCompleted) {
      logger.warn({ 
        email, 
        existingPaymentId: existingCompleted.id,
        userId 
      }, "Attempt to create duplicate early access payment blocked");
      
      return res.status(409).json({ 
        error: "ALREADY_HAS_ACCESS",
        message: "This email already has early access",
        payment: existingCompleted,
        status: "ALREADY_HAS_ACCESS"
      });
    }

    // Also check by user_id if provided (additional safety check)
    if (userId) {
      const { data: existingByUserId } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("user_id", userId)
        .eq("payment_status", "completed")
        .maybeSingle();

      if (existingByUserId) {
        logger.warn({ 
          userId, 
          email,
          existingPaymentId: existingByUserId.id 
        }, "User already has early access payment");
        
        return res.status(409).json({ 
          error: "ALREADY_HAS_ACCESS",
          message: "You already have early access",
          payment: existingByUserId,
          status: "ALREADY_HAS_ACCESS"
        });
      }
    }

    // IMPORTANT: Do NOT create payment record here
    // Payment record will be created ONLY when payment succeeds (via webhook)
    // This prevents database pollution with pending payments that never complete

    // Create Dodo Payment checkout session
    if (!config.dodoPayment.productId) {
      logger.error("DODO_PAYMENT_PRODUCT_ID is not configured");
      return res.status(500).json({ error: "Payment product not configured" });
    }

    // Generate a temporary ID for tracking (not stored in DB yet)
    // This will be used in metadata to help webhook identify the user
    const tempTrackingId = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const checkoutSession = await createCheckoutSession({
      email: email,
      paymentRecordId: tempTrackingId, // Temporary ID for metadata only
      userId: userId,
    });

    if (!checkoutSession) {
      logger.error("Failed to create checkout session");
      return res.status(500).json({ error: "Failed to create checkout session" });
    }

    // Return checkout URL - payment record will be created by webhook on success
    res.json({
      paymentLink: checkoutSession.checkout_url,
      sessionId: checkoutSession.session_id,
      status: "pending",
      message: "Payment record will be created when payment is completed",
    });
  } catch (error: any) {
    logger.error({ error }, "Error creating payment link");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get payment status
 * GET /api/payments/early-access/:paymentId
 */
paymentsRouter.get("/early-access/:paymentId", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    const userId = (req as any).userId;

    const { data: payment, error } = await supabase
      .from("early_access_payments")
      .select("*")
      .eq("id", paymentId)
      .single();

    if (error || !payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Check if user has access (either by user_id or email)
    if (userId && payment.user_id && payment.user_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(payment);
  } catch (error: any) {
    logger.error({ error }, "Error fetching payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Webhook endpoint for Dodo Payment callbacks
 * POST /api/payments/webhook/dodo
 */
paymentsRouter.post("/webhook/dodo", async (req: Request, res: Response) => {
  // Ensure response is sent even if there's an error
  let responseSent = false;
  
  const sendResponse = (status: number, data: any) => {
    if (!responseSent) {
      responseSent = true;
      res.status(status).json(data);
    }
  };

  try {
    // Dodo Payment webhook headers
    const webhookId = req.headers["webhook-id"] as string;
    const webhookSignature = req.headers["webhook-signature"] as string;
    const webhookTimestamp = req.headers["webhook-timestamp"] as string;

    logger.info({ 
      hasWebhookId: !!webhookId,
      hasWebhookSignature: !!webhookSignature,
      hasWebhookTimestamp: !!webhookTimestamp,
      contentType: req.headers["content-type"]
    }, "Webhook received - checking headers");

    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      logger.warn({ 
        webhookId: !!webhookId,
        webhookSignature: !!webhookSignature,
        webhookTimestamp: !!webhookTimestamp,
        allHeaders: Object.keys(req.headers)
      }, "Webhook request missing required headers");
      return sendResponse(401, { error: "Missing webhook headers" });
    }

    // Get raw body for signature verification (req.body is Buffer when using express.raw)
    let rawBody: string;
    try {
      rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    } catch (bodyError) {
      logger.error({ bodyError }, "Failed to extract raw body");
      return sendResponse(400, { error: "Invalid request body" });
    }
    
    // Verify webhook signature
    let isValid = false;
    try {
      isValid = verifyWebhookSignature(
        rawBody,
        webhookId,
        webhookSignature,
        webhookTimestamp,
        config.dodoPayment.webhookSecret
      );
    } catch (sigError) {
      logger.error({ sigError }, "Error during signature verification");
      return sendResponse(401, { error: "Signature verification failed" });
    }

    if (!isValid) {
      logger.warn({ 
        webhookId,
        hasSecret: !!config.dodoPayment.webhookSecret,
        bodyLength: rawBody.length
      }, "Invalid webhook signature - verification failed");
      return sendResponse(401, { error: "Invalid signature" });
    }

    // Parse JSON body
    let event: any;
    try {
      event = typeof req.body === "string" ? JSON.parse(req.body) : (Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body);
    } catch (parseError) {
      logger.error({ parseError, bodyType: typeof req.body }, "Failed to parse webhook body");
      return sendResponse(400, { error: "Invalid JSON body" });
    }

    logger.info({ 
      eventType: event?.event_type || event?.type,
      hasData: !!event?.data,
      eventKeys: event ? Object.keys(event) : []
    }, "Received Dodo Payment webhook - parsed successfully");

    // Dodo Payment webhook structure: { type: "...", data: { ... } } or { event_type: "...", data: { ... } }
    // Handle different event types (Dodo Payment event format)
    const eventType = event?.type || event?.event_type;
    const eventData = event?.data || event; // Extract data payload
    
    // Acknowledge webhook immediately (before processing)
    sendResponse(200, { received: true });

    // Process webhook asynchronously (don't await - let it run in background)
    if (eventType && eventData) {
      switch (eventType) {
        case "payment.succeeded":
        case "payment.completed":
          handlePaymentSuccess(eventData).catch((err) => {
            logger.error({ err, eventData }, "Error processing payment success webhook");
          });
          break;
        case "payment.failed":
          handlePaymentFailure(eventData).catch((err) => {
            logger.error({ err, eventData }, "Error processing payment failure webhook");
          });
          break;
        case "refund.succeeded":
          handlePaymentRefund(eventData).catch((err) => {
            logger.error({ err, eventData }, "Error processing refund webhook");
          });
          break;
        default:
          logger.info({ type: eventType, event }, "Unhandled webhook event type");
      }
    } else {
      logger.warn({ event }, "Webhook event missing type or data");
    }

    return;
  } catch (error: any) {
    logger.error({ error, stack: error?.stack }, "Error processing webhook");
    sendResponse(500, { error: "Internal server error" });
  }
});

// Helper function to create Dodo Payment checkout session
async function createCheckoutSession(params: {
  email: string;
  paymentRecordId: string;
  userId?: string | null;
}): Promise<{ checkout_url: string; session_id: string } | null> {
  try {
    const { email, paymentRecordId, userId } = params;

    if (!config.dodoPayment.productId) {
      logger.error("DODO_PAYMENT_PRODUCT_ID is not configured. Please create a product in Dodo dashboard first.");
      return null;
    }

    if (!config.dodoPayment.apiKey) {
      logger.error("DODO_PAYMENT_API_KEY is not configured");
      return null;
    }

    // Dodo Payment Checkout Session API endpoint
    // Base URL: https://test.dodopayments.com or https://live.dodopayments.com
    const apiUrl = `${config.dodoPayment.baseUrl}/checkouts`;
    
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
      return_url: config.dodoPayment.returnUrl || `${config.email.frontendUrl}/checkout/success`,
      metadata: {
        payment_record_id: paymentRecordId,
        product: "early_access",
        user_id: userId || null,
        email: email,
        created_at: new Date().toISOString(),
      },
      // Always include credit and debit as fallback payment methods
      allowed_payment_method_types: ["credit", "debit"],
    };

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
      logger.error({ 
        status: response.status, 
        statusText: response.statusText,
        error: errorText,
        apiUrl,
      }, "Failed to create Dodo Payment checkout session");
      return null;
    }

    const data = await response.json();
    
    // Response format: { checkout_url: string, session_id: string }
    if (!data.checkout_url || !data.session_id) {
      logger.error({ response: data }, "Invalid checkout session response format");
      return null;
    }
    
    logger.info({ 
      session_id: data.session_id,
      has_checkout_url: !!data.checkout_url,
      return_url: config.dodoPayment.returnUrl || `${config.email.frontendUrl}/checkout/success`,
    }, "Checkout session created successfully");
    
    return {
      checkout_url: data.checkout_url,
      session_id: data.session_id,
    };
  } catch (error: any) {
    logger.error({ error }, "Error creating Dodo Payment checkout session");
    return null;
  }
}

// Helper function to verify webhook signature (Dodo Payment format)
// Uses StandardWebhooks format: HMAC SHA256 of (webhook_id.timestamp.payload)
function verifyWebhookSignature(
  payload: string,
  webhookId: string,
  webhookSignature: string,
  webhookTimestamp: string,
  secret: string
): boolean {
  try {
    if (!secret) {
      logger.error("Webhook secret is not configured");
      return false;
    }

    // StandardWebhooks format: HMAC SHA256 of (webhook_id.timestamp.payload)
    const signedPayload = `${webhookId}.${webhookTimestamp}.${payload}`;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(signedPayload);
    const hash = hmac.digest("hex");
    const expectedSignature = `v1=${hash}`;
    
    // Compare signatures using timing-safe comparison
    const providedSig = webhookSignature.startsWith("v1=") 
      ? webhookSignature 
      : `v1=${webhookSignature}`;
    
    if (providedSig.length !== expectedSignature.length) {
      logger.warn({ 
        providedLength: providedSig.length,
        expectedLength: expectedSignature.length
      }, "Webhook signature length mismatch");
      return false;
    }
    
    return crypto.timingSafeEqual(
      Buffer.from(providedSig),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    logger.error({ error, stack: (error as Error).stack }, "Error verifying webhook signature");
    return false;
  }
}

// Handle successful payment
async function handlePaymentSuccess(data: any) {
  try {
    logger.info({ webhookData: JSON.stringify(data, null, 2) }, "Processing payment success webhook");
    
    // Dodo Payment webhook data structure: { customer: { email, name }, payment_id, total_amount, ... }
    const dodoPaymentId = data.payment_id || data.id;
    const customerEmail = data.customer?.email || data.customer_email || data.email;
    const customerName = data.customer?.name || data.customer_name;
    
    logger.info({ 
      dodoPaymentId, 
      customerEmail, 
      customerName,
      hasCustomer: !!data.customer,
      dataKeys: Object.keys(data)
    }, "Extracted payment data");
    
    if (!customerEmail) {
      logger.warn({ 
        data: JSON.stringify(data, null, 2),
        dataKeys: Object.keys(data),
        customerObject: data.customer 
      }, "Payment success event missing customer email");
      return;
    }

    // CRITICAL: Check if email already has completed payment (ONE PER EMAIL ENFORCEMENT)
    // This MUST happen FIRST before any database operations
    // Prevents duplicate early access grants even if webhook fires multiple times
    const { data: existingCompleted } = await supabase
      .from("early_access_payments")
      .select("*")
      .eq("email", customerEmail)
      .eq("payment_status", "completed")
      .maybeSingle();
    
    if (existingCompleted) {
      logger.warn({ 
        email: customerEmail, 
        existingPaymentId: existingCompleted.id,
        dodoPaymentId: dodoPaymentId,
        webhookAttempt: true
      }, "🚫 Webhook: Email already has completed payment - duplicate prevented (ONE PER EMAIL)");
      
      // Return early - do NOT create or update any payment record
      // This prevents duplicate early access grants
      return;
    }

    // Try to find existing payment record by Dodo payment ID
    let payment = null;
    if (dodoPaymentId) {
      const { data: existingByPaymentId } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("payment_id", dodoPaymentId)
        .maybeSingle();
      
      if (existingByPaymentId) {
        payment = existingByPaymentId;
      }
    }
    
    // If not found, try to find by checkout session_id (stored in metadata)
    if (!payment && data.checkout_session_id) {
      const { data: existingBySession } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("metadata->>session_id", data.checkout_session_id)
        .maybeSingle();
      
      if (existingBySession) {
        payment = existingBySession;
      }
    }
    
    // If not found, try to find by email (pending payments)
    if (!payment) {
      const { data: existingByEmail } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("email", customerEmail)
        .eq("payment_status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (existingByEmail) {
        payment = existingByEmail;
      }
    }
    
    // Try to get user_id from webhook metadata (if available from checkout session)
    let userId = data.metadata?.user_id || null;
    
    // If not in metadata, try to find user by email in users table
    if (!userId) {
      const { data: user } = await supabase
        .from("users")
        .select("id, email")
        .eq("email", customerEmail)
        .maybeSingle();
      
      userId = user?.id || null;
    }
    
    // If still not found, create new payment record
    // NOTE: We already checked for existing completed payment above
    if (!payment) {
      // Dodo Payment amounts are in smallest currency unit (cents for USD)
      // Convert to dollars for storage
      const amountInCents = data.total_amount || data.amount || 0;
      const amountInDollars = typeof amountInCents === 'number' ? amountInCents / 100 : parseFloat(amountInCents) / 100;
      
      // Double-check before insert (race condition protection)
      // This handles the case where two webhooks arrive simultaneously
      const { data: lastCheck } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("email", customerEmail)
        .eq("payment_status", "completed")
        .maybeSingle();
      
      if (lastCheck) {
        logger.warn({ 
          email: customerEmail,
          existingPaymentId: lastCheck.id,
          dodoPaymentId: dodoPaymentId,
          checkType: "race_condition_check"
        }, "🚫 Race condition detected: Email got access between checks - preventing duplicate");
        return;
      }
      
      // CRITICAL: Final check right before insert (additional safety)
      // This is the last application-level check before database constraint
      const { data: finalPreInsertCheck } = await supabase
        .from("early_access_payments")
        .select("id, email, payment_status")
        .eq("email", customerEmail)
        .eq("payment_status", "completed")
        .maybeSingle();
      
      if (finalPreInsertCheck) {
        logger.warn({ 
          email: customerEmail,
          existingPaymentId: finalPreInsertCheck.id,
          dodoPaymentId: dodoPaymentId,
          checkType: "final_pre_insert_check"
        }, "🚫 FINAL CHECK: Email already has completed payment - preventing duplicate insert");
        return;
      }
      
      // Now attempt insert - database constraint will catch if we missed anything
      const { data: newPayment, error: insertError } = await supabase
        .from("early_access_payments")
        .insert({
          user_id: userId,
          email: customerEmail,
          payment_status: "completed",
          payment_id: dodoPaymentId,
          amount: amountInDollars,
          currency: data.currency || "USD",
          metadata: {
            ...data,
            amount_in_cents: amountInCents,
            matched_user: userId ? true : false,
            user_email_match: userId ? customerEmail : null,
            webhook_processed_at: new Date().toISOString(),
            duplicate_prevention_checks: {
              check_1_initial: "passed",
              check_2_race_condition: "passed",
              check_3_final_pre_insert: "passed",
              check_4_database_constraint: "will_catch_if_missed"
            }
          },
        })
        .select()
        .single();
      
      if (insertError) {
        // Check if error is due to unique constraint violation
        if (insertError.code === '23505' || insertError.message?.includes('unique') || insertError.message?.includes('duplicate')) {
          logger.warn({ 
            error: insertError, 
            email: customerEmail,
            dodoPaymentId: dodoPaymentId,
            errorCode: insertError.code,
            errorMessage: insertError.message
          }, "🚫 Database constraint prevented duplicate (unique index worked - THIS IS THE FINAL PROTECTION)");
          
          // Log this as a critical event - database constraint caught a duplicate
          logger.error({ 
            email: customerEmail,
            dodoPaymentId: dodoPaymentId,
            error: insertError
          }, "⚠️ CRITICAL: Application-level checks failed, but database constraint prevented duplicate");
          return;
        }
        
        logger.error({ error: insertError, email: customerEmail }, "Failed to create payment record from webhook");
        return;
      }
      
      payment = newPayment;
      logger.info({ 
        paymentId: newPayment.id, 
        email: customerEmail, 
        userId: userId,
        dodoPaymentId: dodoPaymentId,
        status: "ACCESS_GRANTED"
      }, "✅ Created new payment record from webhook - ACCESS_GRANTED");
    } else {
      // Update existing payment record
      // Dodo Payment amounts are in smallest currency unit (cents for USD)
      // Convert to dollars for storage
      const amountInCents = data.total_amount || data.amount || 0;
      const amountInDollars = typeof amountInCents === 'number' ? amountInCents / 100 : parseFloat(amountInCents) / 100;
      
      // Update user_id if we found a matching user
      const updateData: any = {
        payment_status: "completed",
        payment_id: dodoPaymentId,
        amount: amountInDollars,
        currency: data.currency || payment.currency || "USD",
        metadata: {
          ...(payment.metadata || {}),
          ...data,
          amount_in_cents: amountInCents,
          matched_user: userId ? true : false,
          user_email_match: userId ? customerEmail : null,
        },
        updated_at: new Date().toISOString(),
      };
      
      // CRITICAL: Check again before updating (race condition protection)
      // Another webhook might have completed this payment between our checks
      const { data: finalCheck } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("email", customerEmail)
        .eq("payment_status", "completed")
        .maybeSingle();
      
      if (finalCheck && finalCheck.id !== payment.id) {
        logger.warn({ 
          email: customerEmail,
          existingPaymentId: finalCheck.id,
          currentPaymentId: payment.id,
          dodoPaymentId: dodoPaymentId
        }, "🚫 Another payment was completed for this email - preventing duplicate update");
        return;
      }
      
      // Only update user_id if it's null and we found a match
      if (!payment.user_id && userId) {
        updateData.user_id = userId;
      }

      const { error: updateError } = await supabase
        .from("early_access_payments")
        .update(updateData)
        .eq("id", payment.id);

      if (updateError) {
        logger.error({ error: updateError }, "Failed to update payment status");
        return;
      }
      
      logger.info({ 
        paymentId: payment.id, 
        email: customerEmail, 
        userId: userId || payment.user_id,
        dodoPaymentId: dodoPaymentId 
      }, "✅ Payment marked as completed and linked to user");
    }
    
    // TODO: Send confirmation email, grant access, etc.
  } catch (error: any) {
    logger.error({ error }, "Error handling payment success");
  }
}

// Handle failed payment
async function handlePaymentFailure(data: any) {
  try {
    const customerEmail = data.customer?.email || data.customer_email || data.email;
    const dodoPaymentId = data.payment_id || data.id;
    
    // Try to find by Dodo payment ID first
    if (dodoPaymentId) {
      const { data: payment } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("payment_id", dodoPaymentId)
        .maybeSingle();
      
      if (payment) {
        await supabase
          .from("early_access_payments")
          .update({
            payment_status: "failed",
            metadata: { ...(payment.metadata || {}), ...data },
            updated_at: new Date().toISOString(),
          })
          .eq("id", payment.id);
        
        logger.info({ paymentId: payment.id, email: customerEmail }, "Payment marked as failed");
        return;
      }
    }
    
    // Try to find by email (pending payments)
    if (customerEmail) {
      const { data: payment } = await supabase
        .from("early_access_payments")
        .select("*")
        .eq("email", customerEmail)
        .eq("payment_status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (payment) {
        await supabase
          .from("early_access_payments")
          .update({
            payment_status: "failed",
            metadata: { ...(payment.metadata || {}), ...data },
            updated_at: new Date().toISOString(),
          })
          .eq("id", payment.id);
        
        logger.info({ paymentId: payment.id, email: customerEmail }, "Payment marked as failed");
      }
    }
  } catch (error: any) {
    logger.error({ error }, "Error handling payment failure");
  }
}

// Handle refunded payment
async function handlePaymentRefund(data: any) {
  try {
    const metadata = data.metadata || {};
    const paymentId = metadata.payment_id;

    if (!paymentId) {
      return;
    }

    await supabase
      .from("early_access_payments")
      .update({
        payment_status: "refunded",
        metadata: data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId);

    logger.info({ paymentId }, "Payment marked as refunded");
  } catch (error: any) {
    logger.error({ error }, "Error handling payment refund");
  }
}
