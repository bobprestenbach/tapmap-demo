// Venue matching / creation for events_sync.
// Venues are loaded into memory (a few hundred rows) and matched with fuzzy name + distance.
// Resolutions are cached in public.event_venue_cache keyed by the source's venue key.
import { db } from "../_shared/db.ts";
import { haversineM, normName, point } from "../_shared/geo.ts";
import { politeFetch } from "../_shared/http.ts";
import { geocodeStreet, searchPlace } from "./geocode.ts";
import { decodeEntities, Deadline, inOrleansBox, RawEvent } from "./types.ts";

type V = { id: string; name: string; category: string; data_source: string; lat: number; lng: number; address: string | null };
type CacheRow = {
  key: string; name: string; address?: string | null; website?: string | null;
  lat?: number | null; lng?: number | null; venue_id?: string | null;
  status: string; attempts?: number; meta?: Record<string, unknown>; updated_at?: string;
};
export type Resolution = { venueId: string | null; how: string };

const CREATED_SOURCES = new Set(["ticketmaster", "wwoz"]);
const RETRY_AFTER_MS = 14 * 24 * 3600 * 1000;

const GENERIC = new Set([
  "brewing", "brewery", "bayou", "cafe", "jazz", "music", "grill", "kitchen", "pub", "tavern", "house", "hall",
  "room", "saloon", "hotel", "court", "courtyard", "stage", "market", "park", "theater", "theatre", "street",
  "quarter", "french", "orleans", "other", "place", "spot", "den", "co",
]);

function dice(x: string, y: string): number {
  if (x.length < 2 || y.length < 2) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/**
 * Stricter variant of _shared nameSimilarity. Containment ("Blue Nile" in "Blue Nile - Balcony Room") only
 * scores 0.9 when it falls on word boundaries and the shorter name is not a lone generic word; a single-word
 * short name must also be the first word of the longer one ("Maison" ~ "Maison Bourbon", but not
 * "Bayou" ~ "Pirogue's Whiskey Bayou" or "Saint" ~ "Herbsaint"). Otherwise bigram Dice.
 */
export function sim(a: string, b: string): number {
  // "Bayou Bar at the Pontchartrain", "Blue Nile - Balcony Room", "Bacchanal (OUTDOORS)" -> also try the head.
  const head = (s: string) => s.split(/\s+(?:at|@)\s+|\s+-\s+|\s*\(|,\s*/i)[0].trim();
  let best = simOne(a, b);
  for (const [p, q] of [[head(a), b], [a, head(b)], [head(a), head(b)]]) {
    if (p && q && (p !== a || q !== b)) best = Math.max(best, simOne(p, q));
  }
  return best;
}

function simOne(a: string, b: string): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short)) {
    const toks = short.split(" ").filter((t) => t.length > 1);
    const longToks = long.split(" ").filter((t) => t.length > 1);
    const boundary = ` ${long} `.includes(` ${short} `);
    const meaningful = toks.filter((t) => !GENERIC.has(t));
    if (boundary && meaningful.length > 0 && (toks.length > 1 || longToks[0] === toks[0])) return 0.9;
  }
  return dice(x, y);
}

export class VenueIndex {
  venues: V[] = [];
  byId = new Map<string, V>();
  cache = new Map<string, CacheRow>();
  created = 0;

  async load() {
    const all: V[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db().rpc("events_venue_index").range(from, from + 999);
      if (error) throw new Error(`events_venue_index: ${error.message}`);
      all.push(...(data as V[]));
      if (!data || data.length < 1000) break;
    }
    this.venues = all;
    this.byId = new Map(all.map((v) => [v.id, v]));
    const { data: rows, error } = await db().from("event_venue_cache").select("*");
    if (error) throw new Error(`event_venue_cache: ${error.message}`);
    for (const r of rows ?? []) this.cache.set(r.key, r as CacheRow);
  }

  /** Best venue within radiusM with similarity >= minSim. Ties prefer non-generated (osm/google/curated). */
  matchNear(name: string, lat: number, lng: number, minSim = 0.75, radiusM = 150): V | null {
    let best: V | null = null, bestScore = -1;
    for (const v of this.venues) {
      const d = haversineM({ lat, lng }, v);
      if (d > radiusM) continue;
      const s = sim(name, v.name);
      if (s < minSim) continue;
      const score = s + (CREATED_SOURCES.has(v.data_source) ? 0 : 0.01) - d / 100000;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  /** Best name-only match inside Orleans Parish. */
  matchByName(name: string, minSim = 0.85): V | null {
    let best: V | null = null, bestScore = -1;
    for (const v of this.venues) {
      if (!inOrleansBox(v.lat, v.lng)) continue;
      const s = sim(name, v.name);
      if (s < minSim) continue;
      const score = s + (CREATED_SOURCES.has(v.data_source) ? 0 : 0.01);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  async saveCache(row: CacheRow) {
    const full = { ...this.cache.get(row.key), ...row, updated_at: new Date().toISOString() };
    this.cache.set(row.key, full);
    const { error } = await db().from("event_venue_cache").upsert(full, { onConflict: "key" });
    if (error) console.error("event_venue_cache upsert", error.message);
  }

  async createVenue(v: { name: string; category: string; lat: number; lng: number; address?: string | null; website?: string | null; data_source: string }): Promise<string | null> {
    const { data, error } = await db().from("venues").insert({
      name: v.name, category: v.category, location: point(v.lat, v.lng),
      address: v.address ?? null, website: v.website ?? null, data_source: v.data_source,
    }).select("id").single();
    if (error || !data) { console.error("venue insert", v.name, error?.message); return null; }
    const row: V = { id: data.id, name: v.name, category: v.category, data_source: v.data_source, lat: v.lat, lng: v.lng, address: v.address ?? null };
    this.venues.push(row);
    this.byId.set(row.id, row);
    this.created++;
    return data.id;
  }

  private cachedVenue(key: string): string | null {
    const c = this.cache.get(key);
    return c?.venue_id && this.byId.has(c.venue_id) ? c.venue_id : null;
  }

  /** Ticketmaster (and SeatGeek): venue lat/lng known. Match within 150 m, else create a venue at TM coordinates. */
  async resolveTm(ev: RawEvent, dataSource = "ticketmaster"): Promise<Resolution> {
    const { key, name, address } = ev.venue;
    let { lat, lng } = ev.venue;
    const cached = this.cachedVenue(key);
    if (cached) return { venueId: cached, how: "cache" };
    if ((ev.venue.suspectCoords || lat == null) && address) {
      const c = this.cache.get(key);
      const geo = c?.lat != null && c.meta?.geocoded
        ? { lat: c.lat, lng: c.lng! }
        : await geocodeStreet(address.split(",")[0].replace(/\s*#.*$|\s+(suite|ste)\b.*$/i, "").trim());
      if (geo) { lat = geo.lat; lng = geo.lng; ev.venue.lat = lat; ev.venue.lng = lng; }
      else if (ev.venue.suspectCoords) {
        ev.venue.lat = ev.venue.lng = null; // don't place the event at a placeholder point
        return { venueId: null, how: "bad_coords" };
      }
    }
    if (lat == null || lng == null) return { venueId: null, how: "no_coords" };
    const m = this.matchNear(name, lat, lng, 0.75, 150);
    if (m) {
      await this.saveCache({ key, name, address, lat, lng, venue_id: m.id, status: "resolved", meta: { how: "match", geocoded: !!ev.venue.suspectCoords } });
      return { venueId: m.id, how: "matched" };
    }
    const id = await this.createVenue({
      name, lat, lng, address, data_source: dataSource,
      // venues.category has no theater/arena value; music_venue is the closest fit for any ticketed venue.
      category: "music_venue",
    });
    await this.saveCache({ key, name, address, lat, lng, venue_id: id, status: id ? "resolved" : "pending", meta: { how: "created", geocoded: !!ev.venue.suspectCoords } });
    return { venueId: id, how: id ? "created" : "failed" };
  }

  /**
   * WWOZ: venue name only. 1) cache 2) name match >=0.85 in Orleans 3) scrape the WWOZ organization
   * page for the street address, geocode with Nominatim, match nearby or create a music_venue.
   */
  async resolveWwoz(ev: RawEvent, dl: Deadline, counts: Record<string, number | string>): Promise<Resolution> {
    const { key, name, orgUrl } = ev.venue;
    const cached = this.cachedVenue(key);
    if (cached) return { venueId: cached, how: "cache" };
    const m = this.matchByName(name, 0.85);
    if (m) {
      await this.saveCache({ key, name, venue_id: m.id, status: "resolved", meta: { how: "name" } });
      return { venueId: m.id, how: "matched" };
    }
    const c = this.cache.get(key);
    if (c && c.status !== "pending" && c.updated_at && Date.now() - Date.parse(c.updated_at) < RETRY_AFTER_MS) {
      return { venueId: null, how: c.status };
    }
    if (c && (c.attempts ?? 0) >= 3 && c.status === "pending") {
      await this.saveCache({ key, name, status: "not_found" });
      return { venueId: null, how: "not_found" };
    }
    // Needs network. Cheap first: Nominatim name search (1 req/s), accepted only for a same-named POI
    // inside Orleans Parish. Else scrape the WWOZ organization page (10 s crawl delay) for the address.
    if (dl.left() < 15000) return { venueId: null, how: "deferred" };
    counts.wwoz_venue_lookups = ((counts.wwoz_venue_lookups as number) ?? 0) + 1;
    let address: string | null = null, website: string | null = null;
    let geo = await searchPlace(name);
    if (geo && !(sim(name, geo.name) >= 0.75 && /orleans/i.test(geo.county + " " + geo.display))) geo = null;
    if (geo) address = geo.address;

    if (!geo && orgUrl && dl.left() > 25000) {
      await this.saveCache({ key, name, status: "pending", attempts: (c?.attempts ?? 0) + 1 });
      try {
        const r = await politeFetch(orgUrl, { minDelayMs: 10000 });
        if (r?.ok) {
          const html = await r.text();
          const street = html.match(/class="thoroughfare">([^<]+)</)?.[1];
          const city = html.match(/class="locality">([^<]+)</)?.[1];
          const zip = html.match(/class="postal-code">([^<]+)</)?.[1];
          if (street) address = decodeEntities(`${street}, ${city ?? "New Orleans"}, LA${zip ? " " + zip : ""}`);
          website = html.match(/field-name-field-url[\s\S]*?<a href="([^"]+)"/)?.[1] ?? null;
          if (city && !/new orleans/i.test(city)) {
            await this.saveCache({ key, name, address, website, status: "outside", meta: { city } });
            return { venueId: null, how: "outside" };
          }
        }
      } catch (e) {
        console.error("wwoz org fetch", orgUrl, e);
      }
      if (address) {
        geo = await geocodeStreet(address.split(",")[0]);
      }
    } else if (!geo) {
      return { venueId: null, how: "deferred" };
    }
    if (!geo) {
      await this.saveCache({ key, name, address, website, status: address ? "pending" : "not_found" });
      return { venueId: null, how: "geocode_failed" };
    }
    const orleans = /orleans/i.test(geo.county) || /Orleans Parish/i.test(geo.display);
    if (!orleans || !inOrleansBox(geo.lat, geo.lng)) {
      await this.saveCache({ key, name, address, website, lat: geo.lat, lng: geo.lng, status: "outside", meta: { display: geo.display } });
      return { venueId: null, how: "outside" };
    }
    const near = this.matchNear(name, geo.lat, geo.lng, 0.6, 150);
    const id = near?.id ?? await this.createVenue({
      name, category: "music_venue", lat: geo.lat, lng: geo.lng, address, website, data_source: "wwoz",
    });
    await this.saveCache({
      key, name, address, website, lat: geo.lat, lng: geo.lng, venue_id: id,
      status: id ? "resolved" : "pending", meta: { how: near ? "geocode_match" : "created", display: geo.display },
    });
    return { venueId: id, how: near ? "geo_matched" : id ? "created" : "failed" };
  }
}
