/** Slot Pro stores one shared UTC hour. Each country only changes the clock label. */

export type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
};

const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function zoneParts(timeZone: string, now = new Date()): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    weekday: WEEKDAY[pick("weekday")] || 1,
  };
}

export function isoDate(parts: Pick<ZoneParts, "year" | "month" | "day">): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekMonday(parts: ZoneParts): string {
  const sinceMonday = parts.weekday === 7 ? 6 : parts.weekday - 1;
  return addDays(isoDate(parts), -sinceMonday);
}

export function clockLabel(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("hour")}:${pick("minute")} ${pick("dayPeriod").toUpperCase()}`;
}

/** UTC hour shown on a local clock. NYC 17:00 UTC is 1:00 PM there and 10:30 PM in India. */
export function rangeInZone(utcStart: number, durationHours: number, timeZone: string, now = new Date()): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcStart, 0, 0));
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return `${clockLabel(start, timeZone)} – ${clockLabel(end, timeZone)}`;
}

export function localSortMinutes(utcHour: number, timeZone: string, now = new Date()): number {
  const instant = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
  const hour = pick("hour") % 24;
  return hour * 60 + pick("minute");
}

/** UTC hours a booking owns, wrapping past midnight. 23:00 for 2 hours is 23 and 0. */
export function spanHours(startHour: number, durationHours: number): number[] {
  return Array.from({ length: durationHours }, (_, offset) => (startHour + offset) % 24);
}

export function coversHour(startHour: number, durationHours: number, hour: number): boolean {
  return spanHours(startHour, durationHours).includes(((hour % 24) + 24) % 24);
}
