// Shared venue-import logic for places_sync: neighborhoods, matching, upsert, sources.
import { db } from "../_shared/db.ts";
import { haversineM, nameSimilarity, normName, point } from "../_shared/geo.ts";
import { inc, JobCtx } from "../_shared/job.ts";

/** Fast-food-ish / chain names skipped even without a brand tag. */
export const CHAIN_RE = /\b(ihop|waffle house|shoney'?s|pizza hut|domino'?s|papa john'?s|subway|mcdonald'?s|burger king|wendy'?s|popeyes|starbucks|applebee'?s|chili'?s|hooters|olive garden|denny'?s|buffalo wild wings|taco bell|chipotle|panera|raising cane'?s|five guys|jimmy john'?s|blaze pizza|cava|pei wei|true food kitchen|dave (&|and) buster'?s|hard rock cafe|coyote ugly|cinnaholic|smoothie king|dunkin)\b/i;

export type Hood = { name: string; lat: number; lng: number; r: number };

/** Orleans Parish neighborhoods we import (center + radius in metres). */
export const NEIGHBORHOODS: Hood[] = [
  { name: "French Quarter", lat: 29.9585, lng: -90.0650, r: 850 },
  { name: "Marigny", lat: 29.9645, lng: -90.0555, r: 750 }, // incl. Frenchmen St
  { name: "Bywater", lat: 29.9630, lng: -90.0400, r: 1200 },
  { name: "Tremé", lat: 29.9665, lng: -90.0715, r: 800 },
  { name: "CBD", lat: 29.9515, lng: -90.0730, r: 750 },
  { name: "Warehouse District", lat: 29.9440, lng: -90.0680, r: 650 },
  { name: "Lower Garden District", lat: 29.9360, lng: -90.0745, r: 850 }, // Magazine St
  { name: "Irish Channel", lat: 29.9255, lng: -90.0805, r: 750 },
  { name: "Garden District", lat: 29.9285, lng: -90.0875, r: 650 },
  { name: "Freret", lat: 29.9375, lng: -90.1065, r: 700 },
  { name: "Uptown", lat: 29.9225, lng: -90.1100, r: 1500 },
  { name: "Oak St / Carrollton", lat: 29.9480, lng: -90.1300, r: 1000 },
  { name: "Mid-City", lat: 29.9725, lng: -90.0950, r: 1600 },
];

const ALIASES: Record<string, string> = {
  "frenchmen st": "Marigny", "frenchmen": "Marigny", "marigny": "Marigny",
  "magazine st": "Lower Garden District", "magazine": "Lower Garden District",
  "treme": "Tremé", "oak st": "Oak St / Carrollton", "carrollton": "Oak St / Carrollton",
};

export function selectHoods(names: unknown): Hood[] {
  if (!Array.isArray(names) || names.length === 0) return NEIGHBORHOODS;
  const want = new Set(names.map((n) => {
    const k = String(n).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
    return (ALIASES[k] ?? String(n)).toLowerCase();
  }));
  return NEIGHBORHOODS.filter((h) => want.has(h.name.toLowerCase()) ||
    want.has(h.name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")));
}

/** Nearest neighborhood by distance/radius; null when outside every neighborhood (ratio > maxRatio). */
export function neighborhoodFor(lat: number, lng: number, hoods = NEIGHBORHOODS, maxRatio = 1.25): string | null {
  let best: Hood | null = null, bestRatio = Infinity;
  for (const h of hoods) {
    const ratio = haversineM({ lat, lng }, h) / h.r;
    if (ratio < bestRatio) { bestRatio = ratio; best = h; }
  }
  return best && bestRatio <= maxRatio ? best.name : null;
}

export type VenueIn = {
  name: string;
  category: "restaurant" | "bar" | "music_venue";
  lat: number;
  lng: number;
  address?: string | null;
  neighborhood?: string | null;
  website?: string | null;
  instagram?: string | null;
  phone?: string | null;
  opening_hours?: Record<string, unknown> | null;
  price_level?: number | null;
  rating?: number | null;
  photo_ref?: string | null;
  osm_id?: string | null;
  google_place_id?: string | null;
  data_source: "osm" | "google" | "curated";
  /** curated rows may force the category even onto an existing row */
  force_category?: boolean;
  quality?: number; // for in-batch dedupe preference
};

type Existing = {
  id: string; name: string; category: string; osm_id: string | null; google_place_id: string | null;
  data_source: string; website: string | null; lat: number | null; lng: number | null;
};

export function normalizeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  let s = u.trim().split(/[;\s]/)[0];
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    const url = new URL(s);
    if (!url.hostname.includes(".")) return null;
    if (/(facebook|instagram|twitter|x|tiktok|yelp|tripadvisor)\.com$/i.test(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export function normalizeInstagram(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/(?:instagram\.com\/)?@?([A-Za-z0-9._]{2,30})\/?$/);
  return m ? m[1] : null;
}

/** Collapse near-duplicates inside one batch (same normalized name within 150 m). */
export function dedupeBatch(rows: VenueIn[]): VenueIn[] {
  const out: VenueIn[] = [];
  const sorted = [...rows].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  for (const r of sorted) {
    const n = normName(r.name);
    const dup = out.find((o) => (normName(o.name).replace(/ /g, "") === n.replace(/ /g, "") || nameSimilarity(o.name, r.name) >= 0.92) &&
      haversineM(o, r) < 150);
    if (dup) {
      // enrich keeper with missing fields
      for (const k of ["website", "phone", "instagram", "address", "opening_hours"] as const) {
        // deno-lint-ignore no-explicit-any
        if (!dup[k] && r[k]) (dup as any)[k] = r[k];
      }
      continue;
    }
    out.push(r);
  }
  return out;
}

export async function loadExisting(): Promise<Existing[]> {
  const { data, error } = await db().rpc("venues_for_match");
  if (error) throw new Error(`venues_for_match: ${error.message}`);
  return (data ?? []) as Existing[];
}

function host(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function findMatch(v: VenueIn, existing: Existing[], byOsm: Map<string, Existing>, byGoogle: Map<string, Existing>) {
  if (v.osm_id && byOsm.has(v.osm_id)) return byOsm.get(v.osm_id)!;
  if (v.google_place_id && byGoogle.has(v.google_place_id)) return byGoogle.get(v.google_place_id)!;
  let best: Existing | null = null, bestScore = 0;
  for (const e of existing) {
    if (e.lat == null || e.lng == null) continue;
    const d = haversineM(v, { lat: e.lat, lng: e.lng });
    if (d > 150) continue;
    let sim = nameSimilarity(v.name, e.name);
    if (normName(v.name).replace(/ /g, "") === normName(e.name).replace(/ /g, "")) sim = 1;
    // same website host nearby, or a very close point with a similar name, is the same place
    if (host(v.website) && host(v.website) === host(e.website) && d < 100) sim = Math.max(sim, 0.85);
    const need = d < 30 ? 0.6 : 0.8;
    const score = sim - d / 1500;
    if (sim >= need && score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

/**
 * Upsert venues: match by osm_id / google_place_id / (name similarity + distance < 150 m).
 * Existing rows are enriched (null fields filled, ids attached) rather than duplicated;
 * is_hidden and admin edits of name are never touched.
 */
export async function upsertVenues(ctx: JobCtx, rows: VenueIn[], deadline: number) {
  const existing = await loadExisting();
  const byOsm = new Map(existing.filter((e) => e.osm_id).map((e) => [e.osm_id!, e]));
  const byGoogle = new Map(existing.filter((e) => e.google_place_id).map((e) => [e.google_place_id!, e]));
  const inserts: Record<string, unknown>[] = [];
  const websites: { url: string; venue_id?: string; key?: string }[] = [];

  // Current full rows for the matched ids (to only fill nulls)
  const matched = new Map<VenueIn, Existing>();
  for (const v of rows) {
    const m = findMatch(v, existing, byOsm, byGoogle);
    if (m) matched.set(v, m);
  }
  const ids = [...new Set([...matched.values()].map((e) => e.id))];
  const full = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from("venues").select("*").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`load venues: ${error.message}`);
    for (const r of data ?? []) full.set(r.id, r);
  }

  for (const v of rows) {
    if (Date.now() > deadline) { inc(ctx, "skipped_deadline"); continue; }
    const m = matched.get(v);
    if (!m) {
      inserts.push({
        name: v.name, category: v.category, location: point(v.lat, v.lng), address: v.address ?? null,
        neighborhood: v.neighborhood ?? null, website: v.website ?? null, instagram: v.instagram ?? null,
        phone: v.phone ?? null, opening_hours: v.opening_hours ?? null, price_level: v.price_level ?? null,
        rating: v.rating ?? null, photo_ref: v.photo_ref ?? null, osm_id: v.osm_id ?? null,
        google_place_id: v.google_place_id ?? null, data_source: v.data_source,
      });
      if (v.website) websites.push({ url: v.website, key: v.osm_id ?? v.google_place_id ?? v.name });
      continue;
    }
    const cur = full.get(m.id) ?? {};
    const patch: Record<string, unknown> = {};
    const fill = (k: string, val: unknown) => { if (val != null && val !== "" && (cur[k] == null || cur[k] === "")) patch[k] = val; };
    fill("address", v.address); fill("neighborhood", v.neighborhood); fill("website", v.website);
    fill("instagram", v.instagram); fill("phone", v.phone); fill("price_level", v.price_level);
    fill("photo_ref", v.photo_ref);
    if (v.data_source === "curated" && v.website && cur.website !== v.website) patch.website = v.website;
    if (v.osm_id && !cur.osm_id) patch.osm_id = v.osm_id;
    if (v.google_place_id && !cur.google_place_id) patch.google_place_id = v.google_place_id;
    if (v.rating != null) patch.rating = v.rating;
    if (v.opening_hours) patch.opening_hours = { ...((cur.opening_hours as Record<string, unknown>) ?? {}), ...v.opening_hours };
    if (!cur.location) patch.location = point(v.lat, v.lng);
    if (v.force_category && cur.category !== v.category) patch.category = v.category;
    else if (v.data_source === "google" && v.category === "music_venue" && cur.category === "bar") patch.category = v.category;
    else if (v.data_source === "osm" && cur.data_source === "osm" && cur.category !== "music_venue" &&
      v.category !== cur.category) patch.category = v.category;
    const siteForSource = (patch.website ?? cur.website) as string | null;
    if (siteForSource) websites.push({ url: siteForSource, venue_id: m.id });
    // avoid violating unique osm/google ids when two inputs map to the same row
    if (patch.osm_id && byOsm.has(patch.osm_id as string)) delete patch.osm_id;
    if (patch.google_place_id && byGoogle.has(patch.google_place_id as string)) delete patch.google_place_id;
    if (Object.keys(patch).length === 0 || (Object.keys(patch).length === 1 && "opening_hours" in patch &&
      JSON.stringify(patch.opening_hours) === JSON.stringify(cur.opening_hours))) { inc(ctx, "unchanged"); continue; }
    if (ctx.params.dryRun) { inc(ctx, "would_update"); continue; }
    const { error } = await db().from("venues").update(patch).eq("id", m.id);
    if (error) { inc(ctx, "update_errors"); ctx.log("update", m.id, error.message); continue; }
    if (patch.osm_id) byOsm.set(patch.osm_id as string, m);
    if (patch.google_place_id) byGoogle.set(patch.google_place_id as string, m);
    inc(ctx, v.data_source === "curated" ? "curated_merged" : "updated");
  }

  if (ctx.params.dryRun) { ctx.counts.would_insert = inserts.length; return; }
  const insertedIds = new Map<string, string>();
  for (let i = 0; i < inserts.length; i += 100) {
    const chunk = inserts.slice(i, i + 100);
    const { data, error } = await db().from("venues").insert(chunk).select("id,osm_id,google_place_id,name");
    if (error) {
      // fall back to row-by-row so one bad row doesn't sink the chunk
      for (const r of chunk) {
        const { data: d1, error: e1 } = await db().from("venues").insert(r).select("id,osm_id,google_place_id,name").single();
        if (e1) { inc(ctx, "insert_errors"); ctx.log("insert", r.name, e1.message); continue; }
        insertedIds.set((d1.osm_id ?? d1.google_place_id ?? d1.name) as string, d1.id);
        inc(ctx, "inserted");
      }
      continue;
    }
    for (const d of data ?? []) insertedIds.set((d.osm_id ?? d.google_place_id ?? d.name) as string, d.id);
    inc(ctx, "inserted", data?.length ?? 0);
  }

  // website sources for website_sync
  const srcRows = new Map<string, Record<string, unknown>>();
  for (const w of websites) {
    const venue_id = w.venue_id ?? (w.key ? insertedIds.get(w.key) : undefined);
    if (!venue_id || srcRows.has(w.url)) continue;
    srcRows.set(w.url, { kind: "website", url: w.url, venue_id, cadence: "daily" });
  }
  const src = [...srcRows.values()];
  for (let i = 0; i < src.length; i += 200) {
    const { error, count } = await db().from("sources")
      .upsert(src.slice(i, i + 200), { onConflict: "kind,url", ignoreDuplicates: true, count: "exact" });
    if (error) { inc(ctx, "source_errors"); ctx.log("sources", error.message); } else inc(ctx, "sources_upserted", count ?? 0);
  }
}
