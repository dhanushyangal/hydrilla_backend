import { Request, Response, NextFunction } from "express";
import { supabase } from "../../db.js";
import { logger } from "../../logger.js";

/**
 * Resolve the Dodo customer_id linked to the authenticated Clerk user.
 * Uses the most recent subscription row when multiple exist.
 */
export async function getDodoCustomerIdForUser(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("dodo_customer_id")
    .eq("user_id", userId)
    .not("dodo_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error.message, userId }, "Failed to lookup dodo_customer_id for user");
    return null;
  }
  return (data?.dodo_customer_id as string | null) || null;
}

/**
 * Middleware: when a customer_id query/body is present, require it matches the user's linked customer.
 * If no customer_id is provided, inject the user's linked customer_id into req.query when available.
 */
export async function scopeToUserDodoCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const linked = await getDodoCustomerIdForUser(userId);
    const requested =
      (typeof req.query.customer_id === "string" && req.query.customer_id) ||
      (typeof req.body?.customer_id === "string" && req.body.customer_id) ||
      null;

    if (requested) {
      if (!linked || linked !== requested) {
        return res.status(403).json({ error: "Customer ID does not belong to authenticated user" });
      }
      return next();
    }

    if (linked) {
      req.query.customer_id = linked;
    }
    return next();
  } catch (err: any) {
    logger.error({ err: err?.message }, "scopeToUserDodoCustomer failed");
    return res.status(500).json({ error: "Internal server error" });
  }
}
