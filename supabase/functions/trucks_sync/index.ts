// trucks_sync: curated NOLA food trucks & pop-ups -> venues; truck schedule pages / calendars ->
// happenings (kind truck_stop | popup). Cadence: every 30 min. Params: {"limit": N} sources per run.
//
// Source kinds:
//   truck_calendar   New Orleans Food Trucks association (StreetFoodFinder) "Who's Open" (parsed, no LLM)
//   popup_calendar   nola.today map.json food gigs (parsed, no LLM)
//   brewery_calendar host-venue pages listing which truck/pop-up is where (LLM)
//   truck_site       a truck's own site / schedule page (LLM)
//   instagram        Business Discovery captions (LLM) — only when ENABLE_INSTAGRAM + credentials
// LLM extraction only runs when the page text hash changed, so steady-state LLM cost is ~0.
import { inc, serveJob, type JobCtx } from "../_shared/job.ts";
import { db } from "../_shared/db.ts";
import { htmlToText, politeFetch, sha256, USER_AGENT } from "../_shared/http.ts";
import { extractJson } from "../_shared/llm.ts";
import { chicagoNow, chicagoToUtc, haversineM, NOLA_CENTER, nameSimilarity, normName, point } from "../_shared/geo.ts";
import {
  clampWindow, EXTRACT_SYSTEM, hhmm, looksLikeSchedule, parseJsonLdEvents, parseNolaToday, parseSff, type RawStop, slugify, toMinutes,
} from "./parse.ts";
import { igRecentPosts, instagramEnabled, postsToText } from "./instagram.ts";
import data from "../../../data/trucks/trucks.json" with { type: "json" };

type Host = { slug: string; name: string; type: string; address: string; lat: number; lng: number; website?: string | null };
type Truck = {
  slug: string; name: string; category: "food_truck" | "popup"; cuisine: string; website: string | null;
  schedule_urls: string[]; instagram: string | null; home_base: string | null; rotates_at: string[]; verified_by: string[];
};
type Calendar = { kind: string; name: string; url: string; parser: "sff" | "nolatoday" | "llm"; host?: string };
type SourceRow = {
  id: string; kind: string; url: string; venue_id: string | null; content_hash: string | null;
  last_run_at: string | null; meta: { truck?: string; parser?: string; host?: string; name?: string };
};

const HOSTS = data.hosts as Host[];
const TRUCKS = data.trucks as Truck[];
const CALENDARS = data.calendars as Calendar[];
const HOST_BY_SLUG = new Map(HOSTS.map((h) => [h.slug, h]));
const TIME_BUDGET_MS = 110_000;
const MAX_KM_FROM_CENTER = 20; // Orleans Parish + immediate surroundings
const MAX_GEOCODES_PER_RUN = 10;
const MAX_DAYS_AHEAD = 45;
// LLM sometimes names the vendor generically ("Food pop-ups"); those are not a real truck.
const GENERIC_NAME = /^(the\s+)?((food|local|rotating|various|guest)\s+)*(pop[\s-]?ups?|food\s*trucks?|trucks?|vendors?|food|kitchen|tbd|tba)$/i;

// ---------------------------------------------------------------------------
// venues + sources
// ---------------------------------------------------------------------------
async function ensureVenues(ctx: JobCtx): Promise<Map<string, string>> {
  const { data: rows, error } = await db().from("venues")
    .select("id,name,category,website,instagram,address,data_source")
    .in("category", ["food_truck", "popup"]);
  if (error) throw error;
  const byNorm = new Map<string, (typeof rows)[number]>();
  for (const r of rows ?? []) byNorm.set(normName(r.name), r);
  const ids = new Map<string, string>(); // truck slug or norm name -> venue id
  for (const r of rows ?? []) ids.set("n:" + normName(r.name), r.id);

  for (const t of TRUCKS) {
    const hb = t.home_base ? HOST_BY_SLUG.get(t.home_base) : undefined;
    const want = {
      name: t.name, category: t.category, website: t.website ?? t.schedule_urls[0] ?? null,
      instagram: t.instagram, address: hb ? `${hb.name}, ${hb.address}` : null,
    };
    const ex = byNorm.get(normName(t.name));
    if (!ex) {
      const { data: ins, error: e2 } = await db().from("venues").insert({
        ...want, data_source: "curated", location: hb ? point(hb.lat, hb.lng) : null,
        neighborhood: null,
      }).select("id").single();
      if (e2) { ctx.log("venue insert failed", t.name, e2.message); inc(ctx, "venue_errors"); continue; }
      ids.set(t.slug, ins.id);
      inc(ctx, "venues_created");
    } else {
      ids.set(t.slug, ex.id);
      if (ex.data_source === "curated" && (ex.website !== want.website || ex.instagram !== want.instagram ||
        ex.address !== want.address || ex.category !== want.category)) {
        await db().from("venues").update({ ...want, location: hb ? point(hb.lat, hb.lng) : null }).eq("id", ex.id);
        inc(ctx, "venues_updated");
      }
    }
  }
  return ids;
}

async function ensureSources(venueIds: Map<string, string>): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const c of CALENDARS) {
    rows.push({ kind: c.kind, url: c.url, venue_id: null, cadence: "30m", meta: { parser: c.parser, host: c.host ?? null, name: c.name } });
  }
  for (const t of TRUCKS) {
    for (const u of t.schedule_urls) {
      rows.push({ kind: "truck_site", url: u, venue_id: venueIds.get(t.slug) ?? null, cadence: "30m", meta: { parser: "llm", truck: t.slug, name: t.name } });
    }
    if (instagramEnabled() && t.instagram) {
      rows.push({
        kind: "instagram", url: `https://www.instagram.com/${t.instagram}/`, venue_id: venueIds.get(t.slug) ?? null,
        cadence: "30m", meta: { parser: "instagram", truck: t.slug, name: t.name },
      });
    }
  }
  // de-dupe on (kind,url) – upsert rejects duplicate keys in one statement
  const uniq = [...new Map(rows.map((r) => [`${r.kind}|${r.url}`, r])).values()];
  const { error } = await db().from("sources").upsert(uniq, { onConflict: "kind,url" });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// geocoding (curated hosts -> cache -> US Census (addresses) -> Nominatim (names))
// ---------------------------------------------------------------------------
let geocodesThisRun = 0;
let lastNominatim = 0;

function matchHost(name?: string | null, address?: string | null): Host | null {
  let best: Host | null = null, bestScore = 0;
  for (const h of HOSTS) {
    let s = 0;
    if (name) s = Math.max(s, nameSimilarity(name, h.name));
    if (address) {
      const a = address.toLowerCase(), ha = h.address.toLowerCase();
      const num = ha.match(/^\d+\s+\S+/)?.[0];
      if (num && a.startsWith(num)) s = Math.max(s, 0.95);
      if (nameSimilarity(address, h.name) >= 0.9) s = Math.max(s, 0.9);
    }
    if (s > bestScore) { bestScore = s; best = h; }
  }
  return bestScore >= 0.85 ? best : null;
}

async function geocode(ctx: JobCtx, q: string): Promise<{ lat: number; lng: number } | null> {
  const key = q.toLowerCase().replace(/\s+/g, " ").trim();
  const { data: hit } = await db().from("truck_geocode_cache").select("lat,lng,status").eq("query", key).maybeSingle();
  if (hit) return hit.status === "ok" && hit.lat != null ? { lat: hit.lat, lng: hit.lng } : null;
  if (geocodesThisRun >= MAX_GEOCODES_PER_RUN) { inc(ctx, "geocode_deferred"); return null; }
  geocodesThisRun++;
  let res: { lat: number; lng: number } | null = null, provider = "";
  try {
    if (/^\d+\s+\w/.test(q)) {
      const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(q)}`;
      const r = await politeFetch(u, { minDelayMs: 500, timeoutMs: 15000 });
      if (r?.ok) {
        const c = (await r.json())?.result?.addressMatches?.[0]?.coordinates;
        if (c) { res = { lat: c.y, lng: c.x }; provider = "census"; }
      }
    }
    if (!res) {
      // Nominatim API usage policy: <=1 req/s, identifying UA, cache results (we cache forever).
      const wait = lastNominatim + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastNominatim = Date.now();
      const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-90.30,30.20,-89.60,29.80&bounded=1&q=${encodeURIComponent(q)}`;
      const r = await fetch(u, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = await r.json();
        if (j?.[0]) { res = { lat: +j[0].lat, lng: +j[0].lon }; provider = "nominatim"; }
      }
    }
  } catch (e) {
    ctx.log("geocode error", q, String(e));
    return null; // transient: don't cache
  }
  await db().from("truck_geocode_cache").upsert({
    query: key, lat: res?.lat ?? null, lng: res?.lng ?? null, provider: provider || null, status: res ? "ok" : "not_found",
  });
  inc(ctx, res ? "geocoded" : "geocode_not_found");
  return res;
}

async function locate(ctx: JobCtx, s: RawStop): Promise<{ lat: number; lng: number; name: string | null } | null> {
  if (s.lat != null && s.lng != null && isFinite(s.lat) && isFinite(s.lng)) {
    const h = matchHost(s.location_name, s.address);
    return { lat: s.lat, lng: s.lng, name: h?.name ?? s.location_name ?? null };
  }
  const h = matchHost(s.location_name, s.address);
  if (h) return { lat: h.lat, lng: h.lng, name: h.name };
  const q = s.address
    ? (/new orleans|,\s*la\b|louisiana/i.test(s.address) ? s.address : `${s.address}, New Orleans, LA`)
    : s.location_name ? `${s.location_name}, New Orleans, LA` : null;
  if (!q) return null;
  const g = await geocode(ctx, q);
  return g ? { ...g, name: s.location_name ?? s.address ?? null } : null;
}

// ---------------------------------------------------------------------------
// stops -> happenings
// ---------------------------------------------------------------------------
const squash = (x: string) => normName(x).replace(/\s+/g, "");

function resolveTruck(s: RawStop, src: SourceRow): Truck | null {
  let best: Truck | null = null, score = 0;
  const sq = squash(s.truck ?? "");
  for (const t of TRUCKS) {
    let v = nameSimilarity(s.truck ?? "", t.name);
    const tq = squash(t.name);
    if (tq.length >= 5 && sq.length >= 5 && (sq.includes(tq) || tq.includes(sq))) v = Math.max(v, 0.9);
    if (v > score) { score = v; best = t; }
  }
  if (best && score >= 0.8) return best;
  if (src.meta.truck) return TRUCKS.find((t) => t.slug === src.meta.truck) ?? null;
  return null;
}

async function venueForUnknown(ctx: JobCtx, venueIds: Map<string, string>, name: string, kind: string): Promise<string | null> {
  const k = "n:" + normName(name);
  if (venueIds.has(k)) return venueIds.get(k)!;
  const { data: ins, error } = await db().from("venues").insert({
    name, category: kind === "popup" ? "popup" : "food_truck", data_source: "truck_calendar", location: null,
  }).select("id").single();
  if (error) { ctx.log("unknown truck venue insert failed", name, error.message); return null; }
  venueIds.set(k, ins.id);
  inc(ctx, "venues_created_from_calendars");
  return ins.id;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function storeStops(
  ctx: JobCtx, src: SourceRow, stops: RawStop[], venueIds: Map<string, string>, runStarted: string,
): Promise<void> {
  const now = new Date();
  const p = chicagoNow(now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const maxDate = addDays(today, MAX_DAYS_AHEAD);
  const rows = new Map<string, Record<string, unknown>>();

  for (const s of stops) {
    if (!s?.truck || !s.start) { inc(ctx, "stops_incomplete"); ctx.log("incomplete stop", src.url, JSON.stringify(s).slice(0, 200)); continue; }
    if (GENERIC_NAME.test(s.truck.trim())) { inc(ctx, "stops_generic_name"); continue; }
    const truck = resolveTruck(s, src);
    const kind = s.kind === "popup" || s.kind === "truck_stop" ? s.kind : truck?.category === "popup" ? "popup" : "truck_stop";
    const truckName = truck?.name ?? s.truck.trim();
    const venueId = truck ? venueIds.get(truck.slug) ?? null : await venueForUnknown(ctx, venueIds, truckName, kind);
    const startMin = toMinutes(s.start);
    if (startMin == null) { inc(ctx, "stops_bad_time"); continue; }
    const endMin = s.end === "24:00" ? 1440 : toMinutes(s.end);
    const win = clampWindow(startMin, endMin);
    if (!win) { inc(ctx, "stops_outside_hours"); continue; }

    const loc = await locate(ctx, s);
    if (!loc) { inc(ctx, "stops_unlocated"); continue; }
    const km = haversineM(NOLA_CENTER, loc) / 1000;
    if (km > MAX_KM_FROM_CENTER) { inc(ctx, "stops_outside_area"); continue; }

    const locName = loc.name ?? s.location_name ?? null;
    const locSlug = slugify(locName ?? s.address ?? `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`);
    const tSlug = truck?.slug ?? slugify(truckName);
    const base: Record<string, unknown> = {
      venue_id: venueId,
      kind,
      title: truckName,
      description: [s.description ?? truck?.cuisine ?? null, locName ? `at ${locName}` : null].filter(Boolean).join(" · ") || null,
      location: point(loc.lat, loc.lng),
      location_name: locName,
      source_id: src.id,
      source_url: src.url,
      confidence: Math.max(0, Math.min(1, s.confidence ?? 0.7)),
      last_verified_at: runStarted,
      is_stale: false,
    };

    const dow = (s.days_of_week ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!s.date && dow.length) {
      const ext = `truck:${tSlug}:rec:${[...new Set(dow)].sort().join("")}:${hhmm(win[0]).replace(":", "")}:${locSlug}`;
      rows.set(ext, {
        ...base, external_id: ext, starts_at: null, ends_at: null,
        days_of_week: [...new Set(dow)].sort(), start_time: hhmm(win[0]), end_time: hhmm(win[1]),
      });
      continue;
    }
    if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) { inc(ctx, "stops_no_date"); continue; }
    if (s.date < addDays(today, -1) || s.date > maxDate) { inc(ctx, "stops_out_of_range"); continue; }
    const startsAt = chicagoToUtc(s.date, hhmm(win[0]));
    const endsAt = win[1] >= 1440 ? chicagoToUtc(addDays(s.date, 1), "00:00") : chicagoToUtc(s.date, hhmm(win[1]));
    if (new Date(endsAt) < now) { inc(ctx, "stops_past"); continue; }
    const ext = `truck:${tSlug}:${s.date}:${hhmm(win[0]).replace(":", "")}:${locSlug}`;
    rows.set(ext, {
      ...base, external_id: ext, starts_at: startsAt, ends_at: endsAt, days_of_week: null, start_time: null, end_time: null,
    });
  }

  const list = [...rows.values()];
  if (list.length) {
    const { error } = await db().from("happenings").upsert(list, { onConflict: "external_id" });
    if (error) throw new Error(`happenings upsert: ${error.message}`);
  }
  inc(ctx, "stops_upserted", list.filter((r) => r.starts_at).length);
  inc(ctx, "recurring_upserted", list.filter((r) => !r.starts_at).length);

  // Future one-offs from this source that are no longer listed -> stale (cancelled/moved).
  const keep = list.map((r) => r.external_id as string);
  let q = db().from("happenings").update({ is_stale: true })
    .eq("source_id", src.id).not("starts_at", "is", null).gt("starts_at", now.toISOString()).eq("is_stale", false);
  if (keep.length) q = q.not("external_id", "in", `(${keep.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`);
  const { data: dropped } = await q.select("id");
  if (dropped?.length) inc(ctx, "stops_withdrawn", dropped.length);
}

// ---------------------------------------------------------------------------
// per-source processing
// ---------------------------------------------------------------------------
async function processSource(
  ctx: JobCtx, src: SourceRow, venueIds: Map<string, string>, deadline: number, runStarted: string,
): Promise<void> {
  const parser = src.meta.parser ?? "llm";
  let text = "";
  let stops: RawStop[] | null = null;

  if (parser === "instagram") {
    const t = TRUCKS.find((x) => x.slug === src.meta.truck);
    const posts = t?.instagram ? await igRecentPosts(t.instagram) : [];
    text = postsToText(t?.instagram ?? "", posts);
  } else {
    const r = await politeFetch(src.url, { minDelayMs: 1500, timeoutMs: 20000 });
    if (!r) { await mark(src, "robots_disallowed"); inc(ctx, "robots_disallowed"); return; }
    if (!r.ok) { await mark(src, `http_${r.status}`); inc(ctx, "fetch_errors"); return; }
    const body = await r.text();
    if (parser === "sff") {
      stops = parseSff(body);
      text = JSON.stringify(stops);
    } else if (parser === "nolatoday") {
      try { stops = parseNolaToday(JSON.parse(body)); } catch { stops = []; }
      text = JSON.stringify(stops);
    } else {
      // Structured schema.org events beat LLM extraction: use them when present.
      // On a truck's own site every event is that truck's stop; on calendar pages (breweries, event
      // aggregators) events are mixed (trivia, watch parties...), so they go to the LLM as text.
      const truck = src.meta.truck ? TRUCKS.find((t) => t.slug === src.meta.truck) : null;
      const ld = parseJsonLdEvents(body, truck?.name ?? null);
      if (ld.length && truck) {
        stops = ld;
        text = JSON.stringify(ld);
        inc(ctx, "jsonld_events", ld.length);
      } else {
        text = htmlToText(body);
        if (ld.length) {
          text += "\n\nSTRUCTURED EVENTS (schema.org, times America/Chicago):\n" + ld.map((e) =>
            `- ${e.date} ${e.start}${e.end ? "-" + e.end : ""} | ${e.description ?? ""} | at ${e.location_name ?? "?"}${e.address ? " (" + e.address + ")" : ""}`
          ).join("\n");
        }
      }
    }
  }

  const hash = await sha256(text);
  if (hash === src.content_hash) {
    // Unchanged page: the source still says the same thing -> re-verify its current/future rows.
    const { data: touched } = await db().from("happenings").update({ last_verified_at: runStarted })
      .eq("source_id", src.id).or(`starts_at.is.null,ends_at.gte.${new Date().toISOString()}`).select("id");
    inc(ctx, "reverified", touched?.length ?? 0);
    await mark(src, "unchanged");
    inc(ctx, "sources_unchanged");
    return;
  }

  await db().from("raw_pages").insert({ source_id: src.id, url: src.url, content_hash: hash, text: text.slice(0, 200_000) });

  if (!stops) {
    if (!text.trim() || !looksLikeSchedule(text)) {
      stops = [];
      inc(ctx, "llm_skipped_no_schedule_text");
    } else {
      if (deadline - Date.now() < 35_000) { inc(ctx, "deferred_for_time"); return; } // retry next run (hash not saved)
      const p = chicagoNow();
      const today = `${p.year}-${p.month}-${p.day} (${p.weekday})`;
      const truck = src.meta.truck ? TRUCKS.find((t) => t.slug === src.meta.truck) : null;
      const who = truck
        ? `This page belongs to the ${truck.category === "popup" ? "pop-up" : "food truck"} "${truck.name}" (${truck.cuisine}); use that name for "truck" unless another truck is named.`
        : `This page is "${src.meta.name ?? src.url}" (a venue/calendar listing several trucks or pop-ups).`;
      try {
        inc(ctx, "llm_calls");
        const out = await extractJson<{ stops: RawStop[] }>(
          EXTRACT_SYSTEM,
          `TODAY: ${today}, America/Chicago.\n${who}\nURL: ${src.url}\n\nPAGE TEXT:\n${text.slice(0, 14000)}`,
          2500,
        );
        stops = Array.isArray(out?.stops) ? out.stops : [];
      } catch (e) {
        ctx.log("llm error", src.url, String(e).slice(0, 300));
        inc(ctx, "llm_errors");
        await mark(src, "llm_error");
        return; // hash not saved -> retried next run
      }
    }
  }
  inc(ctx, "stops_found", stops.length);
  await storeStops(ctx, src, stops, venueIds, runStarted);
  await db().from("sources").update({
    content_hash: hash, last_run_at: new Date().toISOString(), last_status: `ok:${stops.length}`,
  }).eq("id", src.id);
  inc(ctx, "sources_changed");
}

async function mark(src: SourceRow, status: string) {
  await db().from("sources").update({ last_run_at: new Date().toISOString(), last_status: status }).eq("id", src.id);
}

serveJob("trucks_sync", async (ctx) => {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const runStarted = new Date().toISOString();
  const limit = Math.max(1, Math.min(200, Number(ctx.params.limit ?? 30)));
  geocodesThisRun = 0;

  const venueIds = await ensureVenues(ctx);
  await ensureSources(venueIds);

  const kinds = ["truck_calendar", "popup_calendar", "brewery_calendar", "truck_site", ...(instagramEnabled() ? ["instagram"] : [])];
  const urls = new Set([...CALENDARS.map((c) => c.url), ...TRUCKS.flatMap((t) => t.schedule_urls)]);
  const { data: srcs, error } = await db().from("sources")
    .select("id,kind,url,venue_id,content_hash,last_run_at,meta")
    .in("kind", kinds)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(500);
  if (error) throw error;
  // Only sources still in the curated file (or instagram ones) — removed entries stop being fetched.
  const todo = (srcs as SourceRow[]).filter((s) => s.kind === "instagram" || urls.has(s.url)).slice(0, limit);
  ctx.counts.sources_total = (srcs ?? []).length;

  for (const s of todo) {
    if (Date.now() > deadline - 5_000) { inc(ctx, "deferred_for_time"); break; }
    try {
      await processSource(ctx, s, venueIds, deadline, runStarted);
      inc(ctx, "sources_processed");
    } catch (e) {
      ctx.log("source failed", s.url, String(e).slice(0, 300));
      inc(ctx, "source_errors");
      await mark(s, `error:${String(e).slice(0, 80)}`);
    }
  }
  ctx.counts.elapsed_ms = Date.now() - started;
});
