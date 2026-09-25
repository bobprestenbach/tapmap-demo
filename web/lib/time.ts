import type { Happening, Kind } from "./types";

export const TZ = "America/Chicago";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

interface ChiParts {
  day: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: string; // Mon
}

export function chicagoParts(d: Date): ChiParts {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) p[x.type] = x.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: p.weekday,
  };
}

/** "7pm", "7:30pm", "noon", "midnight" in America/Chicago. */
export function formatClock(d: Date): string {
  const { hour, minute } = chicagoParts(d);
  if (minute === 0 && hour === 0) return "midnight";
  if (minute === 0 && hour === 12) return "noon";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "am" : "pm";
  return minute === 0 ? `${h12}${ampm}` : `${h12}:${String(minute).padStart(2, "0")}${ampm}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const HOUR = 3600_000;

/** Clock with a day qualifier when it is not "tonight"-ish relative to now. */
function clockWithDay(target: Date, now: Date, mode: "start" | "end"): string {
  const clock = formatClock(target);
  const diff = target.getTime() - now.getTime();
  const tp = chicagoParts(target);
  const np = chicagoParts(now);
  if (tp.day === np.day) return clock;
  // Early-morning end/start of the same night reads naturally without a day.
  if (diff < (mode === "end" ? 18 : 6) * HOUR) return clock;
  if (tp.day === addDays(np.day, 1)) return `tomorrow ${clock}`;
  return `${tp.weekday} ${clock}`;
}

const LIVE_PREFIX: Record<Kind, string> = {
  happy_hour: "Happy hour until",
  live_music: "Live until",
  truck_stop: "Here until",
  special: "Special until",
  popup: "Pop-up until",
  event: "On until",
};

/** Human label for a happening's time window, computed in America/Chicago. */
export function timeLabel(
  h: Pick<Happening, "kind" | "occ_start" | "occ_end" | "is_live">,
  now: Date = new Date(),
): string {
  const start = new Date(h.occ_start);
  const end = new Date(h.occ_end);
  const live = h.is_live || (start <= now && end > now);
  if (live) {
    return `${LIVE_PREFIX[h.kind] ?? "Until"} ${clockWithDay(end, now, "end")}`;
  }
  const when = clockWithDay(start, now, "start");
  if (h.kind === "happy_hour") return when.includes(" ") ? `Happy hour ${when}` : `Happy hour at ${when}`;
  return `Starts ${when}`;
}

/** "4–7pm" style window for the detail card. */
export function windowLabel(h: Pick<Happening, "occ_start" | "occ_end">, now: Date = new Date()): string {
  const s = new Date(h.occ_start);
  const e = new Date(h.occ_end);
  const sp = chicagoParts(s);
  const np = chicagoParts(now);
  let dayPrefix = "";
  if (sp.day === addDays(np.day, 1)) dayPrefix = "Tomorrow, ";
  else if (sp.day !== np.day) dayPrefix = `${sp.weekday}, `;
  return `${dayPrefix}${formatClock(s)} – ${formatClock(e)}`;
}

export function minutesUntil(iso: string, now: Date = new Date()): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatMiles(meters: number): string {
  const mi = meters / 1609.344;
  if (mi < 0.1) return "0.1 mi";
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
