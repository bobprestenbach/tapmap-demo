// Geocoding for events_sync, all free/keyless and rate-limited:
//   - Nominatim (OSM) first, 1 req/s; it returns 403 from Supabase edge IPs, so after the first 403 it is
//     skipped for the rest of the invocation.
//   - Street addresses fall back to the US Census Bureau geocoder (returns the county).
//   - Place-name searches fall back to Photon (komoot, OSM data), biased to New Orleans.
import { NOLA_CENTER } from "../_shared/geo.ts";
import { USER_AGENT } from "../_shared/http.ts";
import { sleep } from "./types.ts";

export type Geo = { lat: number; lng: number; county: string; display: string; name: string; address: string | null };

export const geoStats: Record<string, number> = {};
const bump = (k: string) => (geoStats[k] = (geoStats[k] ?? 0) + 1);

const last = new Map<string, number>();
async function throttle(host: string, ms: number) {
  const wait = (last.get(host) ?? 0) + ms - Date.now();
  if (wait > 0) await sleep(wait);
  last.set(host, Date.now());
}

let nominatimBlocked = false;
async function nominatim(params: Record<string, string>): Promise<Geo | null> {
  if (nominatimBlocked) return null;
  await throttle("nominatim", 1100);
  const u = new URL("https://nominatim.openstreetmap.org/search");
  for (const [k, v] of Object.entries({ ...params, format: "jsonv2", addressdetails: "1", limit: "1", countrycodes: "us" })) {
    u.searchParams.set(k, v);
  }
  try {
    const r = await fetch(u, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      bump(`nominatim_http_${r.status}`);
      if (r.status === 403 || r.status === 429) nominatimBlocked = true;
      return null;
    }
    const hit = (await r.json())?.[0];
    if (!hit) { bump("nominatim_empty"); return null; }
    bump("nominatim_ok");
    const a = hit.address ?? {};
    return {
      lat: +hit.lat, lng: +hit.lon, county: a.county ?? "", display: hit.display_name ?? "", name: hit.name ?? "",
      address: a.road ? `${a.house_number ? a.house_number + " " : ""}${a.road}, New Orleans, LA${a.postcode ? " " + a.postcode : ""}` : null,
    };
  } catch {
    bump("nominatim_error");
    return null;
  }
}

async function census(street: string): Promise<Geo | null> {
  await throttle("census", 500);
  const u = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
  u.search = new URLSearchParams({
    address: `${street}, New Orleans, LA`, benchmark: "Public_AR_Current", vintage: "Current_Current",
    layers: "Counties", format: "json",
  }).toString();
  try {
    const r = await fetch(u, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { bump(`census_http_${r.status}`); return null; }
    const m = (await r.json())?.result?.addressMatches?.[0];
    if (!m) { bump("census_empty"); return null; }
    bump("census_ok");
    return {
      lat: m.coordinates.y, lng: m.coordinates.x, county: m.geographies?.Counties?.[0]?.NAME ?? "",
      display: m.matchedAddress ?? "", name: "", address: m.matchedAddress ?? null,
    };
  } catch {
    bump("census_error");
    return null;
  }
}

async function photon(q: string): Promise<Geo | null> {
  await throttle("photon", 1100);
  const u = new URL("https://photon.komoot.io/api/");
  u.search = new URLSearchParams({ q, lat: String(NOLA_CENTER.lat), lon: String(NOLA_CENTER.lng), limit: "1", lang: "en" }).toString();
  try {
    const r = await fetch(u, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) { bump(`photon_http_${r.status}`); return null; }
    const f = (await r.json())?.features?.[0];
    if (!f) { bump("photon_empty"); return null; }
    bump("photon_ok");
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry.coordinates;
    return {
      lat, lng, county: p.county ?? "", name: p.name ?? "",
      display: [p.name, p.housenumber, p.street, p.city, p.county, p.state].filter(Boolean).join(", "),
      address: p.street ? `${p.housenumber ? p.housenumber + " " : ""}${p.street}, New Orleans, LA${p.postcode ? " " + p.postcode : ""}` : null,
    };
  } catch {
    bump("photon_error");
    return null;
  }
}

/** Geocode a New Orleans street address ("801 N Rampart St"). */
export async function geocodeStreet(street: string): Promise<Geo | null> {
  return (await nominatim({ street, city: "New Orleans", state: "Louisiana" })) ?? (await census(street));
}

/** Search a POI by name in New Orleans. Caller must verify the returned name. */
export async function searchPlace(name: string): Promise<Geo | null> {
  return (await nominatim({ q: `${name}, New Orleans, Louisiana` })) ?? (await photon(`${name} New Orleans`));
}
