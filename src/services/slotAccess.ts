import { config } from "../config.js";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import {
  clockLabel,
  coversHour,
  isValidTimeZone,
  isoDate,
  localSortMinutes,
  rangeInZone,
  spanHours,
  weekMonday,
  zoneParts,
} from "./slotClock.js";

export type SlotPlan = "slot" | "slot_pro";

export type SlotBlock = {
  code: string;
  error: string;
  window?: string;
  now?: string;
};

type BookingRow = {
  user_id: string;
  plan: string;
  timezone: string;
  start_hour: number;
  duration_hours: number;
  changed_on: string | null;
};

const SLOT_DURATION: Record<SlotPlan, number> = {
  slot: 1,
  slot_pro: 2,
};

function slotSeats(plan: SlotPlan): number {
  return plan === "slot_pro" ? config.slot.proSeats : config.slot.seats;
}

export function isSlotPlan(plan: unknown): plan is SlotPlan {
  return plan === "slot" || plan === "slot_pro";
}

function productSlotPlan(productId: string | null | undefined): SlotPlan | null {
  if (productId && productId === config.dodoPayment.slotProductId) return "slot";
  if (productId && productId === config.dodoPayment.slotProProductId) return "slot_pro";
  return null;
}

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202";
}

function notReady(message: string): Error {
  const error = new Error(message);
  (error as Error & { status?: number; code?: string }).status = 503;
  (error as Error & { code?: string }).code = "slot_not_ready";
  return error;
}

export async function entitledSlotPlan(userId: string): Promise<SlotPlan | null> {
  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("status, product_id")
    .eq("user_id", userId)
    .in("status", ["active", "past_due"])
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    logger.error({ error, userId }, "Failed to read subscription for slot check");
    return null;
  }
  for (const row of data || []) {
    const plan = productSlotPlan(row.product_id);
    if (plan) return plan;
  }
  return null;
}

async function loadBooking(userId: string): Promise<BookingRow | null> {
  const { data, error } = await supabase
    .from("slot_bookings")
    .select("user_id, plan, timezone, start_hour, duration_hours, changed_on")
    .eq("user_id", userId)
    .maybeSingle();
  if (missingTable(error)) throw notReady("Hour booking is not available yet. Try again in a moment.");
  if (error) {
    logger.error({ error, userId }, "Failed to read slot booking");
    throw new Error("Could not load your hours. Try again.");
  }
  return (data as BookingRow | null) || null;
}

/** Slot and Slot Pro only. Everyone else skips this and is not looked up in slot tables. */
export async function slotGenerationBlock(userId: string): Promise<SlotBlock | null> {
  const plan = await entitledSlotPlan(userId);
  if (!plan) return null;

  let booking: BookingRow | null;
  try {
    booking = await loadBooking(userId);
  } catch (error: any) {
    if (error?.code === "slot_not_ready") {
      return { code: "slot_not_ready", error: error.message };
    }
    return { code: "slot_check_failed", error: "Could not confirm your hours. Try again in a moment." };
  }
  if (!booking) {
    return {
      code: "slot_required",
      error: "Choose your hour in Settings, under Billing. Generation stays off until you do.",
    };
  }
  const zone = isValidTimeZone(booking.timezone) ? booking.timezone : "UTC";
  const now = new Date();
  if (coversHour(booking.start_hour, booking.duration_hours, now.getUTCHours())) return null;
  const windowLabel = rangeInZone(booking.start_hour, booking.duration_hours, zone, now);
  const nowLabel = clockLabel(now, zone);
  return {
    code: "slot_closed",
    error: `Your hour is ${windowLabel}. It is ${nowLabel} now, so generation is off until then.`,
    window: windowLabel,
    now: nowLabel,
  };
}

function seatLimitSentence(plan: SlotPlan): string {
  const seats = slotSeats(plan);
  return plan === "slot_pro"
    ? `Only ${seats} people can book these hours.`
    : `Only ${seats} people can book this hour.`;
}

export async function releaseSlot(userId: string): Promise<void> {
  const hours = await supabase.from("slot_hours").delete().eq("user_id", userId);
  const booking = await supabase.from("slot_bookings").delete().eq("user_id", userId);
  for (const error of [hours.error, booking.error]) {
    if (error && !missingTable(error)) logger.error({ error, userId }, "Failed to release slot");
  }
}

export async function slotOverview(userId: string, requestedTimezone: string | null) {
  const plan = await entitledSlotPlan(userId);
  if (!plan) {
    return { enrolled: false, plan: null, timezone: null, hours: [] };
  }
  const booking = await loadBooking(userId);
  const timezone =
    (requestedTimezone && isValidTimeZone(requestedTimezone) ? requestedTimezone : null) ||
    (booking && isValidTimeZone(booking.timezone) ? booking.timezone : null);
  if (!timezone) {
    const error = new Error("We could not read your timezone. Refresh and try again.");
    (error as Error & { status?: number; code?: string }).status = 400;
    (error as Error & { code?: string }).code = "timezone";
    throw error;
  }
  const now = new Date();
  const monday = weekMonday(zoneParts("UTC", now));
  const duration = SLOT_DURATION[plan];
  const { data, error } = await supabase.from("slot_hours").select("hour, user_id, plan");
  if (missingTable(error)) throw notReady("Hour booking is not available yet. Try again in a moment.");
  if (error) {
    logger.error({ error, userId }, "Failed to list slot hours");
    throw new Error("Could not load the hours. Try again.");
  }
  const capacity = slotSeats(plan);
  const held = new Map<number, number>();
  for (const row of data || []) {
    if (row.user_id === userId || row.plan !== plan) continue;
    held.set(row.hour as number, (held.get(row.hour as number) || 0) + 1);
  }
  const canChange = !booking || !booking.changed_on || booking.changed_on < monday;
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const span = spanHours(hour, duration);
    return {
      hour,
      label: rangeInZone(hour, duration, timezone, now),
      taken: span.some((item) => (held.get(item) || 0) >= capacity),
      sort: localSortMinutes(hour, timezone, now),
    };
  })
    .sort((a, b) => a.sort - b.sort)
    .map(({ hour, label, taken }) => ({ hour, label, taken }));

  return {
    enrolled: true,
    plan,
    timezone,
    durationHours: duration,
    capacity,
    open: booking ? coversHour(booking.start_hour, booking.duration_hours, now.getUTCHours()) : false,
    window: booking
      ? { startHour: booking.start_hour, label: rangeInZone(booking.start_hour, booking.duration_hours, timezone, now) }
      : null,
    canChange,
    nextChangeOn: canChange ? null : addWeek(monday),
    hours,
  };
}

function addWeek(monday: string): string {
  const [year, month, day] = monday.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

export async function bookSlot(userId: string, startHour: number, timezone: string): Promise<SlotBlock | { ok: true }> {
  const plan = await entitledSlotPlan(userId);
  if (!plan) return { code: "not_slot_plan", error: "Subscribe to Slot or Slot Pro before you choose hours." };
  if (!isValidTimeZone(timezone)) {
    return { code: "timezone", error: "We could not read your timezone. Refresh and try again." };
  }
  if (!Number.isInteger(startHour)) {
    return { code: "invalid_hour", error: "Choose a start time from the list." };
  }
  const now = zoneParts("UTC");
  const { data, error } = await supabase.rpc("set_slot", {
    p_user_id: userId,
    p_plan: plan,
    p_timezone: timezone,
    p_start_hour: startHour,
    p_today: isoDate(now),
    p_week_monday: weekMonday(now),
    p_capacity: slotSeats(plan),
  });
  if (missingTable(error)) {
    return { code: "slot_not_ready", error: "Hour booking is not available yet. Try again in a moment." };
  }
  if (error) {
    logger.error({ error, userId, startHour, timezone }, "set_slot failed");
    return { code: "slot_book_failed", error: "Could not save these hours. Try again." };
  }
  const body = (data || {}) as { ok?: boolean; code?: string; error?: string; hour?: number };
  if (!body.ok) {
    if (body.code === "hour_taken") {
      const when = Number.isInteger(startHour)
        ? `${rangeInZone(startHour, SLOT_DURATION[plan], timezone)} is already booked. `
        : "That time is already booked. ";
      return { code: "hour_taken", error: `${when}${seatLimitSentence(plan)} Choose another time.` };
    }
    if (body.code === "same_hours") return { code: "same_hours", error: "These are already your hours." };
    if (body.code === "change_used") {
      return { code: "change_used", error: "You can change your hours once a week. The next change is on Monday." };
    }
    return { code: body.code || "slot_book_failed", error: body.error || "Could not save these hours. Try again." };
  }
  return { ok: true };
}
