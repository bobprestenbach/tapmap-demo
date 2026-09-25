import { describe, expect, it } from "vitest";
import { ago, formatClock, formatMiles, timeLabel, windowLabel } from "@/lib/time";

// 2026-09-25 is a Friday; CDT = UTC-5.
const ct = (local: string) => new Date(`${local}-05:00`);
const iso = (local: string) => ct(local).toISOString();

describe("formatClock (America/Chicago)", () => {
  it("formats hours and minutes", () => {
    expect(formatClock(ct("2026-09-25T19:00:00"))).toBe("7pm");
    expect(formatClock(ct("2026-09-25T16:30:00"))).toBe("4:30pm");
    expect(formatClock(ct("2026-09-25T09:05:00"))).toBe("9:05am");
    expect(formatClock(ct("2026-09-25T12:00:00"))).toBe("noon");
    expect(formatClock(ct("2026-09-26T00:00:00"))).toBe("midnight");
  });
  it("uses Chicago time regardless of UTC date", () => {
    // 01:00 UTC on the 26th is 8pm CDT on the 25th
    expect(formatClock(new Date("2026-09-26T01:00:00Z"))).toBe("8pm");
  });
  it("handles standard time (CST, UTC-6)", () => {
    expect(formatClock(new Date("2026-12-01T01:00:00Z"))).toBe("7pm");
  });
});

describe("timeLabel", () => {
  const now = ct("2026-09-25T17:15:00");
  it("live happy hour", () => {
    expect(timeLabel({ kind: "happy_hour", is_live: true, occ_start: iso("2026-09-25T16:00:00"), occ_end: iso("2026-09-25T19:00:00") }, now)).toBe(
      "Happy hour until 7pm",
    );
  });
  it("live music crossing midnight reads without a day", () => {
    expect(timeLabel({ kind: "live_music", is_live: true, occ_start: iso("2026-09-25T17:00:00"), occ_end: iso("2026-09-26T01:00:00") }, now)).toBe(
      "Live until 1am",
    );
  });
  it("upcoming tonight", () => {
    expect(timeLabel({ kind: "live_music", is_live: false, occ_start: iso("2026-09-25T21:00:00"), occ_end: iso("2026-09-26T00:00:00") }, now)).toBe(
      "Starts 9pm",
    );
  });
  it("upcoming happy hour", () => {
    expect(timeLabel({ kind: "happy_hour", is_live: false, occ_start: iso("2026-09-25T18:00:00"), occ_end: iso("2026-09-25T20:00:00") }, now)).toBe(
      "Happy hour at 6pm",
    );
  });
  it("tomorrow morning truck stop", () => {
    expect(timeLabel({ kind: "truck_stop", is_live: false, occ_start: iso("2026-09-26T11:00:00"), occ_end: iso("2026-09-26T14:00:00") }, now)).toBe(
      "Starts tomorrow 11am",
    );
  });
  it("after-midnight start soon reads as tonight", () => {
    const late = ct("2026-09-25T23:30:00");
    expect(timeLabel({ kind: "event", is_live: false, occ_start: iso("2026-09-26T01:00:00"), occ_end: iso("2026-09-26T03:00:00") }, late)).toBe("Starts 1am");
  });
  it("multi-day live event shows weekday", () => {
    expect(timeLabel({ kind: "event", is_live: true, occ_start: iso("2026-09-25T10:00:00"), occ_end: iso("2026-09-27T17:00:00") }, now)).toBe(
      "On until Sun 5pm",
    );
  });
  it("derives live from times when flag is stale", () => {
    expect(timeLabel({ kind: "truck_stop", is_live: false, occ_start: iso("2026-09-25T17:00:00"), occ_end: iso("2026-09-25T20:30:00") }, now)).toBe(
      "Here until 8:30pm",
    );
  });
});

describe("misc formatting", () => {
  it("windowLabel", () => {
    const now = ct("2026-09-25T17:15:00");
    expect(windowLabel({ occ_start: iso("2026-09-25T16:00:00"), occ_end: iso("2026-09-25T19:00:00") }, now)).toBe("4pm – 7pm");
    expect(windowLabel({ occ_start: iso("2026-09-26T11:00:00"), occ_end: iso("2026-09-26T14:00:00") }, now)).toBe("Tomorrow, 11am – 2pm");
  });
  it("ago", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(ago("2026-09-25T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-09-25T11:15:00Z", now)).toBe("45m ago");
    expect(ago("2026-09-25T07:00:00Z", now)).toBe("5h ago");
    expect(ago("2026-09-22T12:00:00Z", now)).toBe("3d ago");
  });
  it("formatMiles", () => {
    expect(formatMiles(50)).toBe("0.1 mi");
    expect(formatMiles(1609.344 * 1.26)).toBe("1.3 mi");
    expect(formatMiles(1609.344 * 12.4)).toBe("12 mi");
  });
});
