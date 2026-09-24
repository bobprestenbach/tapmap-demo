// Geo + fuzzy matching helpers.
export const NOLA_CENTER = { lat: 29.9511, lng: -90.0715 };
export const TZ = "America/Chicago";

export function point(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function normName(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/\b(the|new orleans|nola|bar|restaurant|lounge|club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** Dice coefficient on bigrams, 0..1 */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** Current wall-clock parts in America/Chicago. */
export function chicagoNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return parts as Record<string, string>;
}

/** Convert a Chicago local date+time ('2026-09-24', '19:30') to an ISO UTC string (DST-aware). */
export function chicagoToUtc(date: string, time: string): string {
  const [y, mo, da] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // offset of Chicago at that instant
  const offsetMin = (t: number) => {
    const p = chicagoNow(new Date(t));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return (asUtc - t) / 60000;
  };
  let t = guess - offsetMin(guess) * 60000;
  t = guess - offsetMin(t) * 60000;
  return new Date(t).toISOString();
}
