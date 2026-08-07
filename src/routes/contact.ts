import { Router, Request, Response } from "express";
import { supabase } from "../db.js";
import { logger } from "../logger.js";

const USE_CASES = [
  "Game Development",
  "Film / Animation",
  "Architecture / Interiors",
  "AR / VR / XR",
  "Product Visualization",
  "Other",
] as const;

export const contactRouter = Router();

/** POST /api/contact — submit contact form, store in Supabase contact_messages */
contactRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { full_name, work_email, company, use_case, studio_size, message } = req.body as Record<string, string>;

    if (!full_name?.trim() || !work_email?.trim() || !use_case?.trim() || !message?.trim()) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["full_name", "work_email", "use_case", "message"],
      });
    }

    if (!USE_CASES.includes(use_case as (typeof USE_CASES)[number])) {
      return res.status(400).json({ error: "Invalid use_case" });
    }

    const { error } = await supabase.from("contact_messages").insert({
      full_name: full_name.trim(),
      work_email: work_email.trim(),
      company: company?.trim() || null,
      use_case: use_case.trim(),
      studio_size: studio_size?.trim() || null,
      message: message.trim(),
    });

    if (error) {
      logger.error({ err: error }, "Contact form insert failed");
      return res.status(500).json({ error: "Failed to save message" });
    }

    return res.status(201).json({ ok: true });
  } catch (err: unknown) {
    logger.error({ err }, "Contact form error");
    return res.status(500).json({ error: "Internal server error" });
  }
});
