import type { Happening, VenueGroup } from "./types";

export function groupKey(h: Happening): string {
  return h.venue_id ?? `${h.lat.toFixed(5)},${h.lng.toFixed(5)}:${h.location_name ?? ""}`;
}

/** Order: live first, then soonest start, then highest confidence. */
export function compareHappenings(a: Happening, b: Happening): number {
  if (a.is_live !== b.is_live) return a.is_live ? -1 : 1;
  const d = new Date(a.occ_start).getTime() - new Date(b.occ_start).getTime();
  if (d !== 0) return d;
  return b.confidence - a.confidence;
}

/** Collapse multiple happenings at the same venue into one marker. */
export function groupByVenue(items: Happening[]): VenueGroup[] {
  const map = new Map<string, Happening[]>();
  for (const h of items) {
    const k = groupKey(h);
    const arr = map.get(k);
    if (arr) arr.push(h);
    else map.set(k, [h]);
  }
  const out: VenueGroup[] = [];
  for (const [key, arr] of map) {
    arr.sort(compareHappenings);
    const primary = arr[0];
    out.push({ key, lat: primary.lat, lng: primary.lng, category: primary.category, live: primary.is_live, primary, items: arr });
  }
  return out;
}

export function matchesQuery(h: Happening, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [h.venue_name, h.title, h.description, h.neighborhood, h.address, h.location_name, h.price_text]
    .filter(Boolean)
    .join(" \u0001 ")
    .toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

/** Well-known New Orleans neighborhoods for "search a place" → fly the map there. */
export const NEIGHBORHOODS: { name: string; lat: number; lng: number; aliases?: string[] }[] = [
  { name: "French Quarter", lat: 29.9584, lng: -90.0644, aliases: ["quarter", "vieux carre", "bourbon"] },
  { name: "Faubourg Marigny", lat: 29.9636, lng: -90.0551, aliases: ["marigny", "frenchmen"] },
  { name: "Bywater", lat: 29.9636, lng: -90.0404 },
  { name: "CBD", lat: 29.9502, lng: -90.0716, aliases: ["central business district", "downtown"] },
  { name: "Warehouse District", lat: 29.9447, lng: -90.0681, aliases: ["warehouse"] },
  { name: "Garden District", lat: 29.9285, lng: -90.0836, aliases: ["garden"] },
  { name: "Lower Garden District", lat: 29.9365, lng: -90.0746, aliases: ["lower garden"] },
  { name: "Magazine Street", lat: 29.9235, lng: -90.0918, aliases: ["magazine"] },
  { name: "Uptown", lat: 29.9223, lng: -90.1085 },
  { name: "Mid-City", lat: 29.9745, lng: -90.0955, aliases: ["mid city", "midcity"] },
  { name: "Treme", lat: 29.9665, lng: -90.0706, aliases: ["tremé"] },
  { name: "Central City", lat: 29.9391, lng: -90.0869 },
  { name: "Irish Channel", lat: 29.9246, lng: -90.0781 },
  { name: "Freret", lat: 29.9345, lng: -90.1085 },
  { name: "Bayou St. John", lat: 29.9780, lng: -90.0860, aliases: ["bayou st john", "bayou"] },
  { name: "Algiers Point", lat: 29.9530, lng: -90.0540, aliases: ["algiers"] },
];

export function findNeighborhood(q: string) {
  const n = q.trim().toLowerCase();
  if (n.length < 3) return null;
  return (
    NEIGHBORHOODS.find((x) => x.name.toLowerCase() === n || x.aliases?.some((a) => a === n)) ??
    NEIGHBORHOODS.find((x) => x.name.toLowerCase().startsWith(n)) ??
    null
  );
}
