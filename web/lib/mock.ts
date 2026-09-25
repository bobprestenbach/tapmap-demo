import type { Category, Happening, Kind } from "./types";
import { haversineM } from "./time";

type Seed = [string, Category, Kind, string, number, number, number, number, string?];
// name, category, kind, title, lat, lng, startOffsetMin, durationMin, price
const SEEDS: Seed[] = [
  ["Snug Harbor", "music_venue", "live_music", "Ellis Marsalis Quartet tribute", 29.9637, -90.0578, -40, 180, "$25 cover"],
  ["The Spotted Cat", "music_venue", "live_music", "Trad jazz all night", 29.9642, -90.0569, 70, 240, "1-drink min"],
  ["Galatoire's", "restaurant", "special", "Friday lunch — soufflé potatoes", 29.9558, -90.0681, -60, 150, "$$$"],
  ["Coop's Place", "restaurant", "happy_hour", "Half-price apps", 29.9606, -90.0592, -30, 120, "$5 apps"],
  ["Carousel Bar", "bar", "happy_hour", "Vieux Carré specials", 29.9549, -90.0681, -20, 100, "$9 cocktails"],
  ["Barrel Proof", "bar", "happy_hour", "Whiskey happy hour", 29.9395, -90.0736, 50, 120, "$6 pours"],
  ["Loa Bar", "bar", "special", "Botanical cocktails", 29.9515, -90.0697, -90, 300],
  ["Frencheeze", "food_truck", "truck_stop", "Grilled cheese at Pythian Market", 29.9510, -90.0765, -45, 180, "$10–14"],
  ["Diva Dawg", "food_truck", "truck_stop", "Dawgs at Central City lot", 29.9393, -90.0851, -10, 240],
  ["Bywater Night Market", "popup", "popup", "Makers + vinyl pop-up", 29.9640, -90.0420, -15, 200, "Free"],
  ["Pop-up Oyster Bar", "popup", "popup", "Gulf oysters on the half shell", 29.9647, -90.0520, 180, 180, "$1.50 each"],
  ["Cochon", "restaurant", "happy_hour", "Boucherie happy hour", 29.9433, -90.0679, 240, 120],
];

/** Deterministic demo data relative to `now` (dev/screenshots only, never shipped by default). */
export function mockHappenings(now: Date, lat: number, lng: number): Happening[] {
  return SEEDS.map(([name, category, kind, title, la, ln, off, dur, price], i) => {
    const s = new Date(now.getTime() + off * 60000);
    const e = new Date(s.getTime() + dur * 60000);
    return {
      id: `mock-${i}`,
      venue_id: `mock-venue-${i}`,
      venue_name: name,
      category,
      kind,
      title,
      description: "Demo data — shown only with ?mock=1.",
      price_text: price ?? null,
      lat: la,
      lng: ln,
      distance_m: haversineM(lat, lng, la, ln),
      occ_start: s.toISOString(),
      occ_end: e.toISOString(),
      is_live: s <= now,
      address: "New Orleans, LA",
      neighborhood: "French Quarter",
      website: "https://example.com",
      source_url: "https://example.com",
      last_verified_at: new Date(now.getTime() - (i + 1) * 3600_000).toISOString(),
      confidence: 0.8,
      location_name: null,
    } satisfies Happening;
  });
}
