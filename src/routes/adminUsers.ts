import { Router } from "express";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { clerk } from "../middleware/auth.js";
import { grantCredits, removeCredits, listCreditLedger } from "../services/credits.js";
import { sendCreditGrantEmail } from "../services/email.js";

export const adminUsersRouter = Router();

type UserRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
};

type PaymentRow = {
  id: string;
  user_id: string | null;
  email: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string;
  plan: string | null;
  dodo_payment_id: string | null;
  dodo_subscription_id: string | null;
  created_at: string;
};

type SubRow = {
  user_id: string | null;
  plan: string | null;
  status: string;
  product_id: string | null;
  dodo_subscription_id: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type CreditRow = {
  user_id: string;
  plan: string | null;
  credits_total: number | null;
  credits_used: number | null;
  reset_at: string | null;
  subscription_id: string | null;
};

function emailKey(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

let localClerkIdsCache: { at: number; ids: Set<string> } | null = null;

/** User ids from the development Clerk instance. Those are local sign-ins, not the original accounts. */
async function localClerkUserIds(): Promise<Set<string>> {
  if (!config.clerk.secretKey.startsWith("sk_test_")) return new Set();
  const now = Date.now();
  if (localClerkIdsCache && now - localClerkIdsCache.at < 60_000) return localClerkIdsCache.ids;
  const ids = new Set<string>();
  try {
    let offset = 0;
    for (;;) {
      const page = await clerk.users.getUserList({ limit: 100, offset });
      for (const user of page) ids.add(user.id);
      if (page.length < 100) break;
      offset += page.length;
      if (offset >= 500) break;
    }
    localClerkIdsCache = { at: now, ids };
  } catch (err) {
    logger.warn({ err }, "Could not list local Clerk users");
    return localClerkIdsCache?.ids ?? new Set();
  }
  return ids;
}

function personName(user: UserRow, customerName?: string | null): string | null {
  const fromProfile = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fromProfile || customerName || null;
}

function paymentsForUser(user: UserRow, payments: PaymentRow[]): PaymentRow[] {
  const email = emailKey(user.email);
  return payments.filter((row) => row.user_id === user.id || (email && emailKey(row.email) === email));
}

function publicPayment(row: PaymentRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    amount: row.amount_cents ?? 0,
    currency: row.currency || "INR",
    status: row.status,
    plan: row.plan,
    paymentId: row.dodo_payment_id,
    subscriptionId: row.dodo_subscription_id,
  };
}

function publicSubscription(row: SubRow) {
  const meta = row.metadata || {};
  return {
    subscriptionId: row.dodo_subscription_id,
    plan: row.plan,
    status: row.status,
    productId: row.product_id,
    periodEnd: row.current_period_end,
    cancelledAt: row.cancelled_at,
    cancelAtPeriodEnd: meta.cancel_at_next_billing_date === true,
    createdAt: row.created_at,
  };
}

async function loadBillingTables() {
  const [users, payments, subs, credits] = await Promise.all([
    supabase
      .from("users")
      .select("id, email, first_name, last_name, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("subscription_payments")
      .select("id, user_id, email, amount_cents, currency, status, plan, dodo_payment_id, dodo_subscription_id, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("user_subscriptions")
      .select("user_id, plan, status, product_id, dodo_subscription_id, current_period_end, cancelled_at, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("user_credits").select("user_id, plan, credits_total, credits_used, reset_at, subscription_id").limit(1000),
  ]);
  if (users.error) throw users.error;
  if (payments.error) throw payments.error;
  if (subs.error) throw subs.error;
  if (credits.error) throw credits.error;
  return {
    users: (users.data || []) as UserRow[],
    payments: (payments.data || []) as PaymentRow[],
    subs: (subs.data || []) as SubRow[],
    credits: (credits.data || []) as CreditRow[],
  };
}

function summarize(user: UserRow, payments: PaymentRow[], subs: SubRow[], credit: CreditRow | undefined) {
  const mine = paymentsForUser(user, payments);
  const ownSubs = subs.filter((row) => row.user_id === user.id);
  const latest = ownSubs[0] || null;
  const paid = mine.some((row) => row.status === "succeeded");
  const last = mine[0] || null;
  return {
    id: user.id,
    email: user.email,
    name: personName(user, null),
    createdAt: user.created_at,
    paying: paid,
    plan: latest?.plan || credit?.plan || null,
    subscriptionStatus: latest?.status || null,
    cancelAtPeriodEnd: latest?.metadata?.cancel_at_next_billing_date === true,
    periodEnd: latest?.current_period_end || null,
    creditsUsed: credit?.credits_used ?? 0,
    creditsTotal: credit?.credits_total ?? 0,
    lastPaymentAt: last?.created_at || null,
    lastPaymentAmount: last?.amount_cents ?? null,
    lastPaymentCurrency: last?.currency || null,
    lastPaymentStatus: last?.status || null,
    paymentCount: mine.length,
  };
}

adminUsersRouter.get("/", async (req, res) => {
  try {
    const payingOnly = req.query.filter === "paying";
    const { users, payments, subs, credits } = await loadBillingTables();
    const localIds = await localClerkUserIds();
    const people = users.filter((user) => !localIds.has(user.id));
    const visiblePayments = payments.filter((row) => !row.user_id || !localIds.has(row.user_id));
    const creditByUser = new Map(credits.map((row) => [row.user_id, row]));
    const rows = people
      .map((user) => summarize(user, visiblePayments, subs, creditByUser.get(user.id)))
      .filter((row) => (payingOnly ? row.paying : true));
    res.json({
      filter: payingOnly ? "paying" : "all",
      payingCount: people.filter((user) => paymentsForUser(user, visiblePayments).some((row) => row.status === "succeeded")).length,
      users: rows,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/admin/users failed");
    res.status(500).json({ error: "Failed to load users" });
  }
});

adminUsersRouter.get("/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    const { users, payments, subs, credits } = await loadBillingTables();
    const localIds = await localClerkUserIds();
    if (localIds.has(userId)) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = users.find((row) => row.id === userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const visiblePayments = payments.filter((row) => !row.user_id || !localIds.has(row.user_id));
    const credit = credits.find((row) => row.user_id === userId);
    const summary = summarize(user, visiblePayments, subs, credit);
    const history = paymentsForUser(user, visiblePayments).map(publicPayment);
    const subscriptions = subs.filter((row) => row.user_id === userId).map(publicSubscription);

    const [jobsRes, creditLedger] = await Promise.all([
      supabase
        .from("jobs")
        .select("id, status, generate_type, credits_used, created_at, prompt, engine")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(25),
      listCreditLedger(userId),
    ]);

    const jobs = (jobsRes.data || []).map((job) => ({
      id: job.id,
      status: job.status,
      generateType: job.generate_type,
      creditsUsed: job.credits_used ?? 0,
      createdAt: job.created_at,
      prompt: job.prompt || null,
      engine: job.engine || null,
    }));

    return res.json({
      user: summary,
      subscriptions,
      payments: history,
      jobs,
      creditLedger,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/admin/users/:userId failed");
    return res.status(500).json({ error: "Failed to load user" });
  }
});

adminUsersRouter.post("/:userId/credits", async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    const amount = Number(req.body.amount);
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    const action = req.body.action === "remove" ? "remove" : "add";
    const sendEmail = req.body.sendEmail !== false;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("id, email, first_name, last_name")
      .eq("id", userId)
      .maybeSingle();

    if (action === "remove") {
      const result = await removeCredits(userId, amount, {
        reason: reason || undefined,
        adminUserId: req.userId,
        adminEmail: req.userEmail,
      });

      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }

      return res.json({
        success: true,
        action: "remove",
        amount: result.removed,
        remaining: result.remaining,
        total: result.total,
        used: result.used,
      });
    }

    const result = await grantCredits(userId, amount, {
      reason: reason || undefined,
      adminUserId: req.userId,
      adminEmail: req.userEmail,
      source: "admin_grant",
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    if (sendEmail && userRow?.email) {
      const fullName = [userRow.first_name, userRow.last_name].filter(Boolean).join(" ").trim() || null;
      await sendCreditGrantEmail(userRow.email, fullName, amount, reason || null, result.remaining);
    }

    return res.json({
      success: true,
      action: "add",
      amount,
      remaining: result.remaining,
      total: result.total,
      used: result.used,
    });
  } catch (err: any) {
    logger.error({ err, userId: req.params.userId }, "POST /api/admin/users/:userId/credits failed");
    return res.status(500).json({ error: "Failed to update user credits" });
  }
});

adminUsersRouter.get("/:userId/credits/history", async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    const history = await listCreditLedger(userId);
    return res.json({ history });
  } catch (err: any) {
    logger.error({ err, userId: req.params.userId }, "GET /api/admin/users/:userId/credits/history failed");
    return res.status(500).json({ error: "Failed to fetch credit history" });
  }
});
