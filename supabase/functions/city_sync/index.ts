// city_sync: load one city end to end, resumable across invocations (~110 s each).
//
// Params: {"city_id"?: string}. Without city_id the next due city is claimed (claim_city_for_sync, which
// mirrors next_city_for_sync but skips a city another invocation is working on). Phases (cities.phase):
//   osm     Overpass (bars, pubs, restaurants, nightclubs, beer gardens, music venues, live_music=yes) in
//           the city's bbox, filtered to its polygon; chains/fast food skipped; restaurants without a
//           website kept (Google fills them in). Upserted through places_sync/common.ts upsertVenues().
//   discover  Only when OSM kept < 25 venues (thinly mapped towns). Free IDs-only Text Search ("bars in X",
//           "restaurants in X", "live music in X"; 3 pages each, restricted to the city bbox), ids already on a
//           venue dropped, then Place Details for NEW ids only (<= 150 per city per cycle); places inside the
//           polygon that aren't chains are upserted as data_source='google'. Rejected ids are remembered in
//           cities.counts.discover_rejected so a resumed run never buys them twice.
//   enrich  Venues with no website: Google Text Search (IDs Only, free) -> Place Details (Enterprise SKU)
//           -> fill null fields when the name/location match. Capped per cycle by enrich_max_per_city.
// Budget: every Details call (discover + enrich, prewarm cities included) stops when the month's
// budget_status().remaining_usd drops below $1. Spend -> api_usage, one row per SKU per invocation.
//   events  Pokes events_sync (Ticketmaster for this city) and website_sync (this city's sites), then
//           marks the city ready/done and refreshes its counts.
// Phases chain within one invocation while time allows; otherwise the claim is released and the job
// re-invokes itself for the same city. Failures: attempts++, status='error' (retried after 15 min, <5 tries).
// If Overpass fails again on a retry, the osm phase is skipped and the city goes to Google discovery instead.
import { db, flag } from "../_shared/db.ts";
import { budgetStatus, UsageTally } from "../_shared/budget.ts";
import { haversineM, nameSimilarity } from "../_shared/geo.ts";
import {
  findPlaceId, GoogleError, PlaceDetails, placeDetails, PRICE_LEVEL, searchPlaceIds, SKU_DETAILS_ENTERPRISE, SKU_TEXT_IDS,
} from "../_shared/google.ts";
import { inc, JobCtx, serveJob } from "../_shared/job.ts";
import { CHAIN_RE, dedupeBatch, neighborhoodFor, normalizeUrl, upsertVenues, VenueIn } from "../places_sync/common.ts";
import { mapOsmElements, overpass, venueQuery } from "../places_sync/osm.ts";
import { Geometry, pointInGeometry } from "./pip.ts";

const JOB = "city_sync";
const BUDGET_MS = 110_000;
const NEW_ORLEANS = "2255000";
const ENRICH_CONCURRENCY = 5;
const DETAILS_USD = 0.02; // local running estimate while enriching (the ledger prices the free tier exactly)
const MIN_REMAINING_USD = 1; // no Details calls once the month's remaining budget is below this
const DISCOVER_BELOW = 25; // run Google discovery when OSM kept fewer venues than this
const DISCOVER_MAX_DETAILS = 150; // Details calls per city per cycle for discovery
const DISCOVER_QUERIES: { q: string; type?: string; music?: boolean }[] = [
  { q: "bars", type: "bar" },
  { q: "restaurants", type: "restaurant" },
  { q: "live music", music: true },
];
const BAR_TYPES = ["bar", "night_club", "pub", "wine_bar", "cocktail_bar", "lounge_bar", "sports_bar", "beer_garden", "brewpub", "brewery"];
const MUSIC_TYPES = ["live_music_venue", "concert_hall", "performing_arts_theater", "amphitheatre"];
const SKIP_TYPES = ["fast_food_restaurant", "meal_takeaway", "coffee_shop", "cafe", "bakery", "ice_cream_shop", "donut_shop"];

type City = {
  id: string; name: string; state: string; status: string; phase: string | null; prewarm: boolean; attempts: number;
  lat: number; lng: number; w: number; s: number; e: number; n: number; area_km2: number | null; geojson: Geometry;
};

type EnrichRow = {
  id: string; name: string; lat: number; lng: number; address: string | null; phone: string | null;
  price_level: number | null; rating: number | null; opening_hours: Record<string, unknown> | null;
  google_place_id: string | null; website: string | null;
};

async function setCity(id: string, patch: Record<string, unknown>) {
  const { error } = await db().from("cities").update(patch).eq("id", id);
  if (error) throw new Error(`update city: ${error.message}`);
}

async function cityCounts(id: string): Promise<Record<string, unknown>> {
  const { data } = await db().from("cities").select("counts").eq("id", id).single();
  return (data?.counts ?? {}) as Record<string, unknown>;
}

async function mergeCityCounts(id: string, extra: Record<string, unknown>) {
  await setCity(id, { counts: { ...(await cityCounts(id)), ...extra } });
}

async function loadCity(id: string): Promise<City> {
  const { data, error } = await db().rpc("city_for_sync", { p_city_id: id });
  if (error) throw new Error(`city_for_sync: ${error.message}`);
  const c = (data ?? [])[0] as City | undefined;
  if (!c) throw new Error(`unknown city ${id}`);
  return c;
}

/** Pokes another job without waiting for it (pg_net via kick_job; direct fetch as a fallback). */
async function kick(fn: string, body: Record<string, unknown>, ctx: JobCtx) {
  const { error } = await db().rpc("kick_job", { p_fn: fn, p_body: body });
  if (!error) { inc(ctx, `kicked_${fn}`); return; }
  ctx.log("kick_job", fn, error.message, "- falling back to fetch");
  const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).then(() => {}, () => {}); // the target keeps running server-side after we stop listening
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else await p;
  inc(ctx, `kicked_${fn}`);
}

// ---------------------------------------------------------------------------
// phase: osm
// ---------------------------------------------------------------------------
/** Neighborhood label for a point in the city (New Orleans: its neighborhoods), or null when outside it. */
function hoodFor(city: City) {
  const isNola = city.id === NEW_ORLEANS;
  return (lat: number, lng: number): string | null => {
    if (!pointInGeometry(lat, lng, city.geojson)) return null;
    return isNola ? neighborhoodFor(lat, lng) ?? city.name : city.name;
  };
}

/**
 * Returns the number of venues OSM kept, or null when the upsert ran out of time (rows already written
 * come back "unchanged" on the next run).
 */
async function phaseOsm(ctx: JobCtx, city: City, deadline: number): Promise<number | null> {
  await mergeCityCounts(city.id, { cycle_started_at: new Date().toISOString(), discover_details: 0, discover_rejected: [] });
  const q = venueQuery(city.s, city.w, city.n, city.e, 60);
  const els = await overpass(q, 60_000, ctx.log, deadline - 15_000);
  const { venues, stats } = mapOsmElements(els, { includeNoWebsite: true, cityName: city.name, hoodFor: hoodFor(city) });
  ctx.counts.osm_raw = stats.raw;
  ctx.counts.osm_skipped_chain = stats.skipped_chain;
  ctx.counts.osm_outside = stats.skipped_outside;
  const deduped = dedupeBatch(venues);
  ctx.counts.osm_candidates = deduped.length;
  await upsertVenues(ctx, deduped, deadline - 5_000);
  if (ctx.counts.skipped_deadline) return null;
  await mergeCityCounts(city.id, { osm_raw: stats.raw, osm_candidates: deduped.length });
  return deduped.length;
}

// ---------------------------------------------------------------------------
// phase: discover (Google, thin-OSM fallback)
// ---------------------------------------------------------------------------
function googleEnabled() {
  return flag("ENABLE_GOOGLE_PLACES") && !!Deno.env.get("GOOGLE_PLACES_API_KEY");
}

/** Map a Place Details result to a venue; null (with a reason) when it isn't one we list. */
function discoveredVenue(d: PlaceDetails, city: City, music: boolean): { v: VenueIn | null; reason?: string } {
  if (!d.location || !d.displayName?.text) return { v: null, reason: "incomplete" };
  const name = d.displayName.text, lat = d.location.latitude, lng = d.location.longitude;
  const hood = hoodFor(city)(lat, lng);
  if (!hood) return { v: null, reason: "outside" };
  const types = d.types ?? [];
  if (CHAIN_RE.test(name) || (d.primaryType && SKIP_TYPES.includes(d.primaryType)) ||
    types.includes("fast_food_restaurant")) return { v: null, reason: "chain" };
  const isBar = types.some((t) => BAR_TYPES.includes(t));
  const isMusic = types.some((t) => MUSIC_TYPES.includes(t)) ||
    (music && /\b(jazz|music|blues|zydeco|cajun dance|dance hall|theat(er|re)|hall)\b/i.test(name));
  const isFood = types.some((t) => t === "restaurant" || (t.endsWith("_restaurant") && !SKIP_TYPES.includes(t)));
  if (!isBar && !isMusic && !isFood) return { v: null, reason: "other" };
  const website = normalizeUrl(d.websiteUri);
  return {
    v: {
      name, lat, lng, category: isMusic ? "music_venue" : isBar ? "bar" : "restaurant",
      address: d.formattedAddress ?? null, neighborhood: hood, website, phone: d.nationalPhoneNumber ?? null,
      opening_hours: d.regularOpeningHours ? { google: d.regularOpeningHours } : null,
      price_level: d.priceLevel ? PRICE_LEVEL[d.priceLevel] ?? null : null, rating: d.rating ?? null,
      google_place_id: d.id, data_source: "google", quality: (website ? 4 : 0) + (d.regularOpeningHours ? 2 : 0),
    },
  };
}

async function phaseDiscover(ctx: JobCtx, city: City, deadline: number): Promise<EnrichResult> {
  if (!googleEnabled()) { ctx.counts.discover_skipped = "google disabled"; return "done"; }
  const budget = await budgetStatus();
  ctx.counts.budget_remaining_usd = Math.round(budget.remaining_usd * 100) / 100;
  if (budget.remaining_usd < MIN_REMAINING_USD) { ctx.counts.discover_skipped = "budget"; return "done"; }
  const cc = await cityCounts(city.id);
  let used = Number(cc.discover_details ?? 0);
  const rejected = new Set<string>(Array.isArray(cc.discover_rejected) ? cc.discover_rejected as string[] : []);
  if (used >= DISCOVER_MAX_DETAILS) { ctx.counts.discover_cap_hit = DISCOVER_MAX_DETAILS; return "done"; }

  const tally = new UsageTally("google", JOB, city.id);
  const found: VenueIn[] = [];
  let stopReason: string | null = null;
  try {
    // 1. free IDs-only searches
    const rect = { s: city.s, w: city.w, n: city.n, e: city.e };
    const all = new Set<string>(), musicIds = new Set<string>();
    for (const { q, type, music } of DISCOVER_QUERIES) {
      const { ids, requests } = await searchPlaceIds(`${q} in ${city.name}, ${city.state}`, rect, { includedType: type, maxPages: 3 });
      tally.add(SKU_TEXT_IDS, requests);
      for (const id of ids) { all.add(id); if (music) musicIds.add(id); }
    }
    ctx.counts.discover_ids = all.size;
    // 2. drop ids already on a venue or rejected earlier this cycle
    const known = new Set<string>();
    const idList = [...all];
    for (let i = 0; i < idList.length; i += 150) {
      const { data, error } = await db().from("venues").select("google_place_id").in("google_place_id", idList.slice(i, i + 150));
      if (error) throw new Error(`known ids: ${error.message}`);
      for (const r of data ?? []) known.add(r.google_place_id as string);
    }
    const queue = idList.filter((id) => !known.has(id) && !rejected.has(id));
    ctx.counts.discover_new_ids = queue.length;
    // 3. Details for new ids only
    const worker = async () => {
      while (queue.length && !stopReason) {
        if (Date.now() > deadline - 25_000) { stopReason = "time"; return; }
        if (used >= DISCOVER_MAX_DETAILS) { stopReason = "cap"; return; }
        if (budget.remaining_usd - tally.get(SKU_DETAILS_ENTERPRISE) * DETAILS_USD < MIN_REMAINING_USD) { stopReason = "budget"; return; }
        const id = queue.shift()!;
        used++;
        tally.add(SKU_DETAILS_ENTERPRISE);
        try {
          const d = await placeDetails(id, true);
          const { v, reason } = d ? discoveredVenue(d, city, musicIds.has(id)) : { v: null, reason: "gone" };
          if (v) found.push(v); else { rejected.add(id); inc(ctx, `discover_${reason}`); }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof GoogleError && (e.status === 429 || e.status === 403 || e.status >= 500)) { stopReason = `google: ${msg}`; return; }
          rejected.add(id);
          inc(ctx, "discover_error");
          ctx.log("discover", id, msg);
        }
      }
    };
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  } finally {
    // 4. persist what was bought, even when stopping early
    if (found.length) {
      const deduped = dedupeBatch(found);
      ctx.counts.discover_found = deduped.length;
      await upsertVenues(ctx, deduped, deadline + 60_000); // details are paid for: never drop them on the deadline
      const now = new Date().toISOString();
      const { error } = await db().from("venues").update({ enriched_at: now, enrich_status: "ok" })
        .in("google_place_id", deduped.map((v) => v.google_place_id!)).is("enriched_at", null);
      if (error) ctx.log("discover mark", error.message);
    }
    await mergeCityCounts(city.id, { discover_details: used, discover_rejected: [...rejected] });
    ctx.counts.google_ids = Number(ctx.counts.google_ids ?? 0) + tally.get(SKU_TEXT_IDS);
    ctx.counts.google_details = Number(ctx.counts.google_details ?? 0) + tally.get(SKU_DETAILS_ENTERPRISE);
    ctx.counts.discover_details = tally.get(SKU_DETAILS_ENTERPRISE);
    const usd = await tally.flush();
    ctx.counts.est_usd = Math.round((Number(ctx.counts.est_usd ?? 0) + usd) * 10000) / 10000;
  }
  const stop = stopReason as string | null;
  if (stop?.startsWith("google:")) throw new Error(stop);
  if (stop === "budget") ctx.counts.discover_skipped = "budget";
  if (stop === "cap") ctx.counts.discover_cap_hit = DISCOVER_MAX_DETAILS;
  return stop === "time" ? "more" : "done";
}

// ---------------------------------------------------------------------------
// phase: enrich
// ---------------------------------------------------------------------------
type EnrichResult = "done" | "more";

async function enrichOne(v: EnrichRow, city: City, tally: UsageTally, ctx: JobCtx): Promise<string> {
  const now = new Date().toISOString();
  const mark = async (status: string, extra: Record<string, unknown> = {}) => {
    const { error } = await db().from("venues").update({ enriched_at: now, enrich_status: status, ...extra }).eq("id", v.id);
    if (error && error.code === "23505" && "google_place_id" in extra) {
      // someone else claimed this place id in the meantime
      await db().from("venues").update({ enriched_at: now, enrich_status: "duplicate" }).eq("id", v.id);
      return "duplicate";
    }
    if (error) throw new Error(`venue update: ${error.message}`);
    return status;
  };

  // Imported from Google already: details were bought then, there is nothing new to learn.
  if (v.google_place_id) return await mark("ok");

  tally.add(SKU_TEXT_IDS);
  const placeId = await findPlaceId(`${v.name}, ${city.name}, ${city.state}`, { lat: v.lat, lng: v.lng }, 300);
  if (!placeId) return await mark("no_match");

  const { data: other } = await db().from("venues").select("id").eq("google_place_id", placeId).neq("id", v.id).limit(1);
  if (other?.length) return await mark("duplicate");

  tally.add(SKU_DETAILS_ENTERPRISE);
  const d = await placeDetails(placeId);
  if (!d || !d.location || !d.displayName?.text) return await mark("no_match");
  const sim = nameSimilarity(v.name, d.displayName.text);
  const dist = haversineM(v, { lat: d.location.latitude, lng: d.location.longitude });
  if (sim < 0.6 || dist > 250) {
    ctx.log("mismatch", v.name, "->", d.displayName.text, sim.toFixed(2), Math.round(dist) + "m");
    return await mark("mismatch");
  }

  const patch: Record<string, unknown> = { google_place_id: placeId };
  const website = normalizeUrl(d.websiteUri);
  if (website && !v.website) patch.website = website;
  if (d.nationalPhoneNumber && !v.phone) patch.phone = d.nationalPhoneNumber;
  if (d.priceLevel && v.price_level == null && PRICE_LEVEL[d.priceLevel] != null) patch.price_level = PRICE_LEVEL[d.priceLevel];
  if (d.rating != null && v.rating == null) patch.rating = d.rating;
  if (d.formattedAddress && !v.address) patch.address = d.formattedAddress;
  if (d.regularOpeningHours && !v.opening_hours?.google) {
    patch.opening_hours = { ...(v.opening_hours ?? {}), google: d.regularOpeningHours };
  }
  const status = await mark("ok", patch);
  if (status === "ok" && patch.website) {
    const { error } = await db().from("sources").upsert(
      { kind: "website", url: patch.website, venue_id: v.id, cadence: "daily" },
      { onConflict: "kind,url", ignoreDuplicates: true },
    );
    if (error) ctx.log("sources", error.message); else inc(ctx, "websites_added");
  }
  return status;
}

async function phaseEnrich(ctx: JobCtx, city: City, deadline: number): Promise<EnrichResult> {
  if (!googleEnabled()) {
    ctx.counts.enrich_skipped = "google disabled";
    return "done";
  }
  const { data: capSetting } = await db().rpc("setting", { p_key: "enrich_max_per_city" });
  const cap = Number(capSetting ?? 600);
  const cycleStart = String((await cityCounts(city.id)).cycle_started_at ?? "1970-01-01T00:00:00Z");
  const { count: doneThisCycle } = await db().from("venues").select("id", { count: "exact", head: true })
    .eq("city_id", city.id).gte("enriched_at", cycleStart);
  let capLeft = cap - (doneThisCycle ?? 0);
  if (capLeft <= 0) { ctx.counts.enrich_cap_hit = cap; return "done"; }

  const budget = await budgetStatus();
  ctx.counts.budget_remaining_usd = Math.round(budget.remaining_usd * 100) / 100;
  const overBudget = (extra: number) => budget.remaining_usd - extra < MIN_REMAINING_USD;
  if (overBudget(0)) {
    const { data } = await db().rpc("venues_to_enrich", { p_city_id: city.id, p_limit: 1000 });
    ctx.counts.budget_skipped = (data ?? []).length;
    return "done";
  }

  const tally = new UsageTally("google", JOB, city.id);
  const seen = new Set<string>();
  let consecutiveGoogleErrors = 0;
  let stopReason: string | null = null;
  try {
    while (!stopReason) {
      if (Date.now() > deadline - 10_000) { stopReason = "time"; break; }
      const { data, error } = await db().rpc("venues_to_enrich", { p_city_id: city.id, p_limit: Math.min(200, capLeft) });
      if (error) throw new Error(`venues_to_enrich: ${error.message}`);
      const queue = ((data ?? []) as EnrichRow[]).filter((v) => !seen.has(v.id));
      if (queue.length === 0) break; // nothing left
      const worker = async () => {
        while (queue.length && !stopReason) {
          if (Date.now() > deadline - 10_000) { stopReason = "time"; return; }
          if (capLeft <= 0) { stopReason = "cap"; return; }
          if (overBudget(tally.get(SKU_DETAILS_ENTERPRISE) * DETAILS_USD)) { stopReason = "budget"; return; }
          const v = queue.shift()!;
          seen.add(v.id);
          capLeft--;
          try {
            const status = await enrichOne(v, city, tally, ctx);
            inc(ctx, `enriched_${status}`);
            consecutiveGoogleErrors = 0;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (e instanceof GoogleError && (e.status === 429 || e.status === 403 || e.status >= 500)) {
              // quota/auth/outage: leave the venue un-stamped so a later run retries it
              inc(ctx, "google_errors");
              ctx.log("google", v.name, msg);
              if (++consecutiveGoogleErrors >= 5) stopReason = `google: ${msg}`;
              continue;
            }
            inc(ctx, "enriched_error");
            ctx.log("enrich", v.name, msg);
            await db().from("venues").update({ enriched_at: new Date().toISOString(), enrich_status: "error" }).eq("id", v.id);
          }
        }
      };
      await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
    }
  } finally {
    ctx.counts.google_ids = Number(ctx.counts.google_ids ?? 0) + tally.get(SKU_TEXT_IDS);
    ctx.counts.google_details = Number(ctx.counts.google_details ?? 0) + tally.get(SKU_DETAILS_ENTERPRISE);
    const usd = await tally.flush();
    ctx.counts.est_usd = Math.round((Number(ctx.counts.est_usd ?? 0) + usd) * 10000) / 10000;
  }
  if (stopReason?.startsWith("google:")) throw new Error(stopReason);
  if (stopReason === "budget") {
    const { data } = await db().rpc("venues_to_enrich", { p_city_id: city.id, p_limit: 1000 });
    ctx.counts.budget_skipped = (data ?? []).length;
    return "done";
  }
  if (stopReason === "cap") { ctx.counts.enrich_cap_hit = cap; return "done"; }
  return stopReason === "time" ? "more" : "done";
}

// ---------------------------------------------------------------------------
// phase: events (+ finish)
// ---------------------------------------------------------------------------
async function phaseEvents(ctx: JobCtx, city: City) {
  await kick("events_sync", { adapters: ["ticketmaster"], city_id: city.id }, ctx);
  await kick("website_sync", { city_id: city.id, limit: 40, concurrency: 6 }, ctx);
}

// ---------------------------------------------------------------------------
serveJob(JOB, async (ctx) => {
  const deadline = Date.now() + BUDGET_MS;
  const wanted = typeof ctx.params.city_id === "string" && ctx.params.city_id ? ctx.params.city_id : null;
  const { data: claimed, error: claimErr } = await db().rpc("claim_city_for_sync", { p_city_id: wanted });
  if (claimErr) throw new Error(`claim_city_for_sync: ${claimErr.message}`);
  if (!claimed) { ctx.counts.skipped = wanted ? "city busy or unknown" : "nothing to do"; return; }

  const city = await loadCity(claimed as string);
  ctx.counts.city = `${city.name} (${city.id})`;
  ctx.counts.phase_start = city.phase ?? "osm";
  let phase = city.phase ?? "osm";

  try {
    while (phase !== "done") {
      const left = deadline - Date.now();
      if (phase === "osm") {
        if (left < 60_000) break;
        let kept: number | null;
        try {
          kept = await phaseOsm(ctx, city, deadline);
        } catch (e) {
          // Overpass mirrors are often down/refusing from the edge runtime. After one failed attempt,
          // fall back to Google discovery (free IDs-only search, capped Details) so the city isn't stuck.
          const msg = e instanceof Error ? e.message : String(e);
          if (!/Overpass/i.test(msg) || (city.attempts ?? 0) < 1) throw e;
          ctx.counts.osm_fallback = msg.slice(0, 160);
          kept = 0;
        }
        if (kept == null) break;
        phase = kept < DISCOVER_BELOW ? "discover" : "enrich";
      } else if (phase === "discover") {
        if (left < 40_000) break;
        if ((await phaseDiscover(ctx, city, deadline)) === "more") break;
        phase = "enrich";
      } else if (phase === "enrich") {
        if (left < 20_000) break;
        if ((await phaseEnrich(ctx, city, deadline)) === "more") break;
        phase = "events";
      } else if (phase === "events") {
        await phaseEvents(ctx, city);
        const now = new Date().toISOString();
        const { data: cur } = await db().from("cities").select("synced_at").eq("id", city.id).single();
        await setCity(city.id, {
          status: "ready", phase: "done", attempts: 0, last_error: null, refreshed_at: now,
          synced_at: cur?.synced_at ?? now,
        });
        const { error } = await db().rpc("refresh_city_counts", { p_city_id: city.id });
        if (error) ctx.log("refresh_city_counts", error.message);
        phase = "done";
        break;
      } else {
        phase = "osm";
      }
      await setCity(city.id, { phase, last_attempt_at: new Date().toISOString() });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.counts.phase_end = phase;
    await setCity(city.id, {
      status: "error", phase, attempts: (city.attempts ?? 0) + 1, last_error: `${phase}: ${msg}`.slice(0, 1000),
      last_attempt_at: new Date().toISOString(),
    });
    throw e;
  }

  ctx.counts.phase_end = phase;
  ctx.counts.inserted = Number(ctx.counts.inserted ?? 0);
  ctx.counts.enriched_ok = Number(ctx.counts.enriched_ok ?? 0);
  if (phase !== "done") {
    // Out of time mid-cycle: release the claim (the lock is last_attempt_at within 150 s) and continue
    // in a fresh invocation right away instead of waiting for the next cron tick.
    await setCity(city.id, { phase, last_attempt_at: new Date(Date.now() - 151_000).toISOString() });
    await kick("city_sync", { city_id: city.id }, ctx);
  }
});
