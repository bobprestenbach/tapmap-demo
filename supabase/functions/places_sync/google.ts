// Google Places API (New) Text Search provider. Behind ENABLE_GOOGLE_PLACES.
// Cost: Text Search with websiteUri/regularOpeningHours/rating/priceLevel/phone is billed at the Pro/Enterprise
// tier (~$32-35 per 1000 requests); ~13 hoods x 3 queries x maxPages pages per weekly run.
import { CHAIN_RE, Hood, neighborhoodFor, normalizeUrl, VenueIn } from "./common.ts";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id", "places.displayName", "places.location", "places.formattedAddress", "places.websiteUri",
  "places.regularOpeningHours", "places.priceLevel", "places.rating", "places.nationalPhoneNumber",
  "places.photos", "places.types", "nextPageToken",
].join(",");

const QUERIES: { q: string; category: VenueIn["category"]; type?: string }[] = [
  { q: "bars", category: "bar", type: "bar" },
  { q: "restaurants", category: "restaurant", type: "restaurant" },
  { q: "live music venues", category: "music_venue" },
];

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

type GPlace = {
  id: string; displayName?: { text: string }; location?: { latitude: number; longitude: number };
  formattedAddress?: string; websiteUri?: string; regularOpeningHours?: Record<string, unknown>;
  priceLevel?: string; rating?: number; nationalPhoneNumber?: string; photos?: { name: string }[]; types?: string[];
};

export async function fetchGoogleVenues(hoods: Hood[], opts: { maxPages?: number; deadline: number }, log: (...a: unknown[]) => void) {
  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY not set");
  const out: VenueIn[] = [];
  const stats = { requests: 0, raw: 0, skipped_outside: 0, skipped_chain: 0 };
  const seen = new Set<string>();
  for (const h of hoods) {
    for (const { q, category, type } of QUERIES) {
      let pageToken: string | undefined;
      for (let page = 0; page < (opts.maxPages ?? 1); page++) {
        if (Date.now() > opts.deadline) return { venues: out, stats };
        const body: Record<string, unknown> = {
          textQuery: `${q} in ${h.name}, New Orleans, LA`,
          pageSize: 20,
          locationBias: { circle: { center: { latitude: h.lat, longitude: h.lng }, radius: Math.min(h.r * 1.2, 50000) } },
        };
        if (type) body.includedType = type;
        if (pageToken) body.pageToken = pageToken;
        stats.requests++;
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`Places ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as { places?: GPlace[]; nextPageToken?: string };
        for (const p of j.places ?? []) {
          stats.raw++;
          if (!p.location || !p.displayName?.text || seen.has(p.id)) continue;
          seen.add(p.id);
          if (CHAIN_RE.test(p.displayName.text) ||
            p.types?.some((t) => ["fast_food_restaurant", "meal_takeaway", "coffee_shop"].includes(t))) { stats.skipped_chain++; continue; }
          const lat = p.location.latitude, lng = p.location.longitude;
          const hood = neighborhoodFor(lat, lng);
          if (!hood) { stats.skipped_outside++; continue; }
          const types = p.types ?? [];
          const isBar = types.some((t) => ["bar", "night_club", "pub", "wine_bar", "cocktail_bar", "lounge_bar", "sports_bar", "beer_garden", "brewpub"].includes(t));
          const isMusic = types.some((t) => ["live_music_venue", "concert_hall", "performing_arts_theater", "amphitheatre", "night_club"].includes(t)) ||
            /\b(jazz|music|blues|theat(er|re)|hall)\b/i.test(p.displayName.text);
          out.push({
            name: p.displayName.text, lat, lng,
            category: category === "music_venue" && isMusic ? "music_venue" : isBar ? "bar" : category === "music_venue" ? "restaurant" : category,
            address: p.formattedAddress ?? null, neighborhood: hood, website: normalizeUrl(p.websiteUri),
            phone: p.nationalPhoneNumber ?? null,
            opening_hours: p.regularOpeningHours ? { google: p.regularOpeningHours } : null,
            price_level: p.priceLevel ? PRICE[p.priceLevel] ?? null : null, rating: p.rating ?? null,
            photo_ref: p.photos?.[0]?.name ?? null, google_place_id: p.id, data_source: "google",
            quality: (p.websiteUri ? 4 : 0) + (p.regularOpeningHours ? 2 : 0),
          });
        }
        pageToken = j.nextPageToken;
        if (!pageToken) break;
      }
    }
    log("google", h.name, out.length);
  }
  return { venues: out, stats };
}
