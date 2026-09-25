// Google Places API (New) — the cheap enrichment path used by city_sync:
//   1. Text Search with FieldMask "places.id" only  -> "Text Search Essentials (IDs Only)" SKU, free.
//   2. Place Details for that id with contact/atmosphere fields -> Enterprise SKU ($20/1000, 1000 free/month).
// Both need GOOGLE_PLACES_API_KEY; callers should also check ENABLE_GOOGLE_PLACES.

export const SKU_TEXT_IDS = "google_text_ids";
export const SKU_DETAILS_ENTERPRISE = "google_details_enterprise";

const TEXT_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const DETAILS = "https://places.googleapis.com/v1/places/";
const DETAILS_MASK = [
  "id", "displayName", "location", "formattedAddress", "websiteUri", "regularOpeningHours",
  "rating", "priceLevel", "nationalPhoneNumber",
].join(",");

export const PRICE_LEVEL: Record<string, number> = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export type PlaceDetails = {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  formattedAddress?: string;
  websiteUri?: string;
  regularOpeningHours?: Record<string, unknown>;
  rating?: number;
  priceLevel?: string;
  nationalPhoneNumber?: string;
};

/** HTTP error from Google; `status` lets callers tell quota/auth failures from per-place misses. */
export class GoogleError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

function apiKey(): string {
  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY not set");
  return key;
}

/** Text Search (IDs Only, free). Returns the best place id near (lat,lng), or null. */
export async function findPlaceId(
  textQuery: string, center: { lat: number; lng: number }, radiusM = 300,
): Promise<string | null> {
  const r = await fetch(TEXT_SEARCH, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": "places.id" },
    body: JSON.stringify({
      textQuery,
      pageSize: 1,
      locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new GoogleError(r.status, `searchText ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { places?: { id: string }[] };
  return j.places?.[0]?.id ?? null;
}

/** Place Details (Enterprise SKU). Returns null on 404 (stale id). */
export async function placeDetails(id: string): Promise<PlaceDetails | null> {
  const r = await fetch(DETAILS + encodeURIComponent(id), {
    headers: { "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": DETAILS_MASK },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new GoogleError(r.status, `details ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as PlaceDetails;
}
