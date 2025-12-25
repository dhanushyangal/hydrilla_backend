import { Request, Response, NextFunction } from "express";
import { createClerkClient } from "@clerk/clerk-sdk-node";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Initialize Clerk client
const clerk = createClerkClient({ secretKey: config.clerk.secretKey });

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

/**
 * Middleware to verify Clerk JWT tokens and extract user info.
 * Sets req.userId if authentication is successful.
 * Does not block unauthenticated requests - just sets userId to undefined.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // No auth token provided - continue without user info
      req.userId = undefined;
      return next();
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix
    
    if (!token || token === "undefined" || token === "null") {
      req.userId = undefined;
      return next();
    }

    // Verify the JWT token with Clerk
    const payload = await clerk.verifyToken(token);
    
    if (payload && payload.sub) {
      req.userId = payload.sub;
      logger.debug({ userId: payload.sub }, "User authenticated");
    }
    
    next();
  } catch (err: any) {
    // Token verification failed - continue without user info
    logger.debug({ err: err.message }, "Token verification failed");
    req.userId = undefined;
    next();
  }
}

/**
 * Middleware that requires authentication.
 * Returns 401 if no valid token is provided.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = authHeader.substring(7);
    
    if (!token || token === "undefined" || token === "null") {
      return res.status(401).json({ error: "Invalid authentication token" });
    }

    // Verify the JWT token with Clerk
    const payload = await clerk.verifyToken(token);
    
    if (!payload || !payload.sub) {
      return res.status(401).json({ error: "Invalid authentication token" });
    }

    req.userId = payload.sub;
    logger.debug({ userId: payload.sub }, "User authenticated (required)");
    
    next();
  } catch (err: any) {
    logger.error({ err: err.message }, "Authentication failed");
    return res.status(401).json({ error: "Authentication failed" });
  }
}

/**
 * Sync user data from Clerk to Supabase.
 * Called after successful authentication.
 */
export async function syncUserToDatabase(userId: string) {
  try {
    const user = await clerk.users.getUser(userId);
    
    if (!user) {
      logger.warn({ userId }, "Could not fetch user from Clerk");
      return null;
    }

    // Import supabase here to avoid circular dependency
    const { supabase } = await import("../db.js");
    
    const userData = {
      id: user.id,
      email: user.emailAddresses[0]?.emailAddress || null,
      first_name: user.firstName || null,
      last_name: user.lastName || null,
      image_url: user.imageUrl || null,
      updated_at: new Date().toISOString(),
    };

    // First check if user exists
    const { data: existingUser, error: selectError } = await supabase
      .from("users")
      .select("id")
      .eq("id", userId)
      .single();

    if (selectError && selectError.code !== "PGRST116") {
      // PGRST116 means not found, which is OK
      logger.error({ err: selectError, userId }, "Error checking if user exists");
    }

    if (existingUser) {
      // Update existing user
      const { error: updateError } = await supabase
        .from("users")
        .update({
          email: userData.email,
          first_name: userData.first_name,
          last_name: userData.last_name,
          image_url: userData.image_url,
          updated_at: userData.updated_at,
        })
        .eq("id", userId);

      if (updateError) {
        logger.error({ err: updateError, userId }, "Failed to update user in database");
        return null;
      }
      logger.debug({ userId }, "User updated in database");
    } else {
      // Insert new user
      const { error: insertError } = await supabase
        .from("users")
        .insert({
          id: userData.id,
          email: userData.email,
          first_name: userData.first_name,
          last_name: userData.last_name,
          image_url: userData.image_url,
          created_at: new Date().toISOString(),
          updated_at: userData.updated_at,
        });

      if (insertError) {
        logger.error({ err: insertError, userId }, "Failed to insert user in database");
        return null;
      }
      logger.info({ userId, email: userData.email }, "New user created in database");
    }

    return userData;
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "Error syncing user to database");
    return null;
  }
}

