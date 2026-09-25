// OpenStreetMap (Overpass API) venue provider.
import { USER_AGENT } from "../_shared/http.ts";
import { Hood, neighborhoodFor, normalizeInstagram, normalizeUrl, VenueIn } from "./common.ts";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export type OsmEl = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

/** Fast-food-ish / chain names skipped even without a brand tag. */
const CHAIN_RE = /\b(ihop|waffle house|shoney'?s|pizza hut|domino'?s|papa john'?s|subway|mcdonald'?s|burger king|wendy'?s|popeyes|starbucks|applebee'?s|chili'?s|hooters|olive garden|denny'?s|buffalo wild wings|taco bell|chipotle|panera|raising cane'?s|five guys|jimmy john'?s|blaze pizza|cava|pei wei|true food kitchen|dave (&|and) buster'?s|hard rock cafe|coyote ugly|cinnaholic|smoothie king|dunkin)\b/i;

function bbox(hoods: Hood[]): [number, number, number, number] {
  let s = 90, w = 180, n = -90, e = -180;
  for (const h of hoods) {
    const dLat = (h.r * 1.3) / 111320, dLng = (h.r * 1.3) / (111320 * Math.cos((h.lat * Math.PI) / 180));
    s = Math.min(s, h.lat - dLat); n = Math.max(n, h.lat + dLat);
    w = Math.min(w, h.lng - dLng); e = Math.max(e, h.lng + dLng);
  }
  return [s, w, n, e];
}

export async function overpass(query: string, timeoutMs = 60000, log?: (...a: unknown[]) => void): Promise<OsmEl[]> {
  const errs: string[] = [];
  let lastErr = "";
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) { lastErr = `${url} ${r.status} ${(await r.text()).slice(0, 120)}`; errs.push(lastErr); log?.("overpass", lastErr); continue; }
      const j = await r.json();
      return (j.elements ?? []) as OsmEl[];
    } catch (e) {
      lastErr = `${url} ${e instanceof Error ? e.message : e}`;
      errs.push(lastErr);
      log?.("overpass", lastErr);
    }
  }
  throw new Error(`All Overpass mirrors failed: ${errs.join(" | ")}`);
}

function address(t: Record<string, string>): string | null {
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  if (!street) return t["addr:full"] ?? null;
  const city = t["addr:city"] ?? "New Orleans";
  const tail = [t["addr:state"] ?? "LA", t["addr:postcode"]].filter(Boolean).join(" ");
  return `${street}, ${city}, ${tail}`;
}

export type OsmOpts = { includeNoWebsite?: boolean; elements?: OsmEl[] };

/** Fetch + map OSM venues for the given neighborhoods. */
export async function fetchOsmVenues(hoods: Hood[], opts: OsmOpts, log: (...a: unknown[]) => void) {
  const [s, w, n, e] = bbox(hoods);
  const b = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  const q = `[out:json][timeout:30];(
    nwr["amenity"~"^(bar|pub|restaurant|nightclub|biergarten|music_venue)$"]["name"](${b});
    nwr["live_music"="yes"]["name"](${b});
  );out center tags;`;
  // Pre-fetched Overpass elements may be passed in (scripts/venues/osm_backfill.sh) when the
  // edge runtime's egress IP is refused/slow at the Overpass mirrors.
  const els = opts.elements?.length ? opts.elements : await overpass(q, 35000, log);
  const stats = { raw: els.length, skipped_chain: 0, skipped_outside: 0, skipped_no_website: 0 };
  const out: VenueIn[] = [];
  const seen = new Set<string>();
  for (const el of els) {
    const t = el.tags ?? {};
    const osm_id = `${el.type}/${el.id}`;
    if (seen.has(osm_id)) continue;
    seen.add(osm_id);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null || !t.name) continue;
    const amenity = t.amenity ?? "";
    if (amenity === "fast_food" || (amenity === "cafe" && t.live_music !== "yes")) continue;
    if (t.brand || t["brand:wikidata"] || CHAIN_RE.test(t.name)) { stats.skipped_chain++; continue; }
    const hood = neighborhoodFor(lat, lng, hoods);
    if (!hood) { stats.skipped_outside++; continue; }
    const website = normalizeUrl(t.website ?? t["contact:website"] ?? t.url);
    const isMusic = amenity === "music_venue" || t.live_music === "yes" ||
      (amenity === "nightclub" && /music|jazz|blues/i.test(t.name + " " + (t.description ?? "")));
    const category: VenueIn["category"] = isMusic ? "music_venue"
      : ["bar", "pub", "nightclub", "biergarten"].includes(amenity) ? "bar" : "restaurant";
    // Prefer venues with a website (website_sync needs them); keep bars/music without one.
    if (!website && category === "restaurant" && !opts.includeNoWebsite) { stats.skipped_no_website++; continue; }
    const hours = t.opening_hours ? { osm: t.opening_hours } : null;
    out.push({
      name: t.name.trim(), category, lat, lng, address: address(t), neighborhood: hood, website,
      instagram: normalizeInstagram(t["contact:instagram"] ?? t.instagram),
      phone: t.phone ?? t["contact:phone"] ?? null, opening_hours: hours, osm_id, data_source: "osm",
      quality: (website ? 4 : 0) + (t.opening_hours ? 2 : 0) + (t["addr:street"] ? 1 : 0) + (el.type === "node" ? 0.5 : 0),
    });
  }
  return { venues: out, stats };
}
