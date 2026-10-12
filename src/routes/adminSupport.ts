import { Router, Request, Response } from "express";
import {
  listSupportFeedback,
  getSupportFeedbackById,
  updateSupportFeedback,
  deleteSupportFeedback,
  SupportStatus,
} from "../repository/supportFeedback.js";
import { logger } from "../logger.js";

export const adminSupportRouter = Router();

const VALID_STATUSES: SupportStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * GET /api/admin/support — list support & feedback tickets with stats
 */
adminSupportRouter.get("/", async (req: Request, res: Response) => {
  try {
    const typeParam = typeof req.query.type === "string" ? req.query.type : undefined;
    const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
    const searchParam = typeof req.query.search === "string" ? req.query.search : undefined;
    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const offsetParam = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : undefined;

    const result = await listSupportFeedback({
      type: typeParam,
      status: statusParam,
      search: searchParam,
      limit: limitParam,
      offset: offsetParam,
    });

    return res.json({
      ok: true,
      stats: result.stats,
      items: result.items,
      total: result.total,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[Admin Support] GET /api/admin/support failed");
    const errorMsg = err instanceof Error ? err.message : "Failed to load support tickets";
    return res.status(500).json({ error: errorMsg });
  }
});

/**
 * GET /api/admin/support/:id — get single ticket
 */
adminSupportRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const ticket = await getSupportFeedbackById(id);

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    return res.json({
      ok: true,
      ticket,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[Admin Support] GET ticket failed");
    return res.status(500).json({ error: "Failed to load ticket" });
  }
});

/**
 * PATCH /api/admin/support/:id — update ticket status or admin notes
 */
adminSupportRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { status, admin_notes } = req.body as {
      status?: string;
      admin_notes?: string;
    };

    if (status && !VALID_STATUSES.includes(status as SupportStatus)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const updated = await updateSupportFeedback(id, {
      status: status as SupportStatus | undefined,
      admin_notes,
    });

    if (!updated) {
      return res.status(404).json({ error: "Ticket not found or could not be updated" });
    }

    return res.json({
      ok: true,
      ticket: updated,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[Admin Support] PATCH ticket failed");
    const errorMsg = err instanceof Error ? err.message : "Failed to update ticket";
    return res.status(500).json({ error: errorMsg });
  }
});

/**
 * DELETE /api/admin/support/:id — delete ticket
 */
adminSupportRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    await deleteSupportFeedback(id);
    return res.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ err }, "[Admin Support] DELETE ticket failed");
    const errorMsg = err instanceof Error ? err.message : "Failed to delete ticket";
    return res.status(500).json({ error: errorMsg });
  }
});
