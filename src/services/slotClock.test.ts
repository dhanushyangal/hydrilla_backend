import assert from "node:assert/strict";
import test from "node:test";
import { coversHour, isoDate, localSortMinutes, rangeInZone, spanHours, weekMonday, zoneParts } from "./slotClock.js";

const october = new Date("2026-10-15T17:00:00.000Z");

test("one UTC hour is the same moment in every country", () => {
  assert.equal(rangeInZone(17, 1, "UTC", october), "5:00 PM – 6:00 PM");
  assert.equal(rangeInZone(17, 1, "America/New_York", october), "1:00 PM – 2:00 PM");
  assert.equal(rangeInZone(17, 1, "Asia/Kolkata", october), "10:30 PM – 11:30 PM");
  assert.equal(rangeInZone(17, 1, "Asia/Kathmandu", october), "10:45 PM – 11:45 PM");
  assert.equal(rangeInZone(17, 1, "Pacific/Auckland", october), "6:00 AM – 7:00 AM");
  const winter = new Date("2026-01-15T17:00:00.000Z");
  assert.equal(rangeInZone(17, 1, "America/New_York", winter), "12:00 PM – 1:00 PM");
  assert.equal(rangeInZone(17, 1, "Asia/Kolkata", winter), "10:30 PM – 11:30 PM");
  assert.equal(coversHour(17, 1, october.getUTCHours()), true);
  assert.equal(coversHour(17, 1, 18), false);
});

test("a two-hour Slot Pro window can start late and wrap midnight", () => {
  assert.deepEqual(spanHours(23, 2), [23, 0]);
  assert.equal(coversHour(23, 2, 0), true);
  assert.equal(coversHour(23, 2, 1), false);
  assert.equal(rangeInZone(22, 2, "America/New_York", october), "6:00 PM – 8:00 PM");
  assert.equal(rangeInZone(22, 2, "Asia/Kolkata", october), "3:30 AM – 5:30 AM");
});

test("local labels sort through the viewer's day", () => {
  const indiaNoon = localSortMinutes(7, "Asia/Kolkata", october);
  const indiaNight = localSortMinutes(17, "Asia/Kolkata", october);
  assert.equal(indiaNoon, 12 * 60 + 30);
  assert.equal(indiaNight, 22 * 60 + 30);
  assert.ok(indiaNoon < indiaNight);
});

test("the weekly change follows UTC Monday", () => {
  const sunday = zoneParts("UTC", new Date("2026-10-18T12:00:00.000Z"));
  assert.equal(sunday.weekday, 7);
  assert.equal(isoDate(sunday), "2026-10-18");
  assert.equal(weekMonday(sunday), "2026-10-12");
});
