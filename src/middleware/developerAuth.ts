import type { Request, Response, NextFunction } from "express";
import { verifyDeveloperApiKey } from "../repository/developerApiKeys.js";
import { ensureCreditsRow } from "../services/credits.js";
import { syncUserToDatabase } from "./auth.js";
import { logger } from "../logger.js";

declare global {
  namespace Express {
    interface Request {
      developerUserId?: string;
      developerKeyId?: string;
      developerKeyName?: string;
    }
  }
}

function extractBearerOrHeaderKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (token) {
      return token;
    }
  }

  const customHeader = req.headers["x-api-key"];
  if (typeof customHeader === "string") {
    const token = customHeader.trim();
    if (token) {
      return token;
    }
  }

  if (Array.isArray(customHeader) && customHeader.length > 0) {
    const token = customHeader[0]?.trim();
    if (token) {
      return token;
    }
  }

  return null;
}

export async function requireDeveloperAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey = extractBearerOrHeaderKey(req);

  if (!apiKey) {
    res.status(401).json({
      error: {
        message:
          "Authentication required. Provide your Hydrilla API key in the 'Authorization: Bearer hyd_live_...' or 'x-api-key' header.",
        type: "authentication_error",
        code: "api_key_missing",
      },
    });
    return;
  }

  try {
    const verified = await verifyDeveloperApiKey(apiKey);
    if (!verified) {
      res.status(401).json({
        error: {
          message: "Invalid or revoked API key. Verify your key in the Hydrilla developer dashboard.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    // Attach identifiers to request
    req.userId = verified.userId;
    req.developerUserId = verified.userId;
    req.developerKeyId = verified.keyId;
    req.developerKeyName = verified.name;

    // Ensure user row and initial credits row exist
    await syncUserToDatabase(verified.userId);
    const credits = await ensureCreditsRow(verified.userId);

    const remainingCredits = (credits?.credits_total ?? 0) - (credits?.credits_used ?? 0);
    if (remainingCredits <= 0) {
      res.status(402).json({
        error: {
          message:
            "Your credit balance is exhausted. Top up credits or upgrade your plan in Hydrilla Studio.",
          type: "insufficient_credits",
          code: "credit_balance_exhausted",
          remaining_credits: remainingCredits,
        },
      });
      return;
    }

    next();
  } catch (err: unknown) {
    logger.error({ err }, "Developer authentication error");
    res.status(500).json({
      error: {
        message: "An internal authentication error occurred.",
        type: "api_error",
        code: "internal_error",
      },
    });
  }
}
