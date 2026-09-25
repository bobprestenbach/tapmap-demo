// events_sync: Ticketmaster + WWOZ Livewire (+ SeatGeek stub) -> happenings, matched to venues.
//
// Ticketmaster is multi-city: one Discovery query per city (rpc active_cities(), or just `city_id`), radius
// scaled by area; an event is kept when its venue point is inside ANY allowed city (rpc city_at). Each city has
// its own sources row (kind 'ticketmaster', url 'tm:<city_id>'); cities are processed oldest last_run_at first
// and skipped when refreshed within `tm_min_age_h`, so a run that hits the time budget resumes next time.
// WWOZ stays New Orleans-scoped (it is a NOLA station).
//
// Params (JSON body or query string):
//   adapters: ["ticketmaster","wwoz","seatgeek"]   (default: all; seatgeek no-ops unless ENABLE_SEATGEEK)
//   city_id:  Ticketmaster for this one city only (any status; ignores tm_min_age_h)
//   tm_min_age_h: skip cities whose Ticketmaster pull is newer than this (default 5)
//   days:     WWOZ days to fetch starting today (default 3, max 7) — each page costs >=10 s (crawl delay)
//   tm_days:  Ticketmaster window in days (default 14)
//   budget_ms: time budget (default 110000)
//
// Other local listings: OffBeat (/events widget returns no rows; no public events API) and
// NOLA.com / Gambit (calendar is a JS-rendered third-party widget) are intentionally skipped.
import { serveJob, inc, JobCtx } from "../_shared/job.ts";
import { db } from "../_shared/db.ts";
import { NOLA_CITY_ID, point } from "../_shared/geo.ts";
import { deadline, Deadline, RawEvent } from "./types.ts";
import { CityCheck, VenueIndex } from "./venues.ts";
import { geoStats } from "./geocode.ts";
import { fetchTicketmaster, TmCity } from "./ticketmaster.ts";
import { fetchWwoz, WWOZ_CALENDAR } from "./wwoz.ts";
import { fetchSeatGeek } from "./seatgeek.ts";

const SG_URL = "https://api.seatgeek.com/2/events";

async function sourceId(kind: string, url: string, meta?: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await db().from("sources")
    .upsert({ kind, url, cadence: "6h", ...(meta ? { meta } : {}) }, { onConflict: "kind,url" }).select("id").single();
  if (error) console.error("sources upsert", error.message);
  return data?.id ?? null;
}

async function markSource(id: string | null, status: string) {
  if (!id) return;
  await db().from("sources").update({ last_run_at: new Date().toISOString(), last_status: status }).eq("id", id);
}

type Row = Record<string, unknown>;

function toRow(e: RawEvent, venueId: string | null, srcId: string | null, now: string): Row | null {
  const base: Row = {
    venue_id: venueId,
    kind: e.kind,
    title: e.title.slice(0, 300),
    description: e.description ?? null,
    price_text: e.priceText ?? null,
    starts_at: e.startsAt,
    ends_at: e.endsAt ?? null,
    source_id: srcId,
    source_url: e.sourceUrl,
    external_id: e.externalId,
    confidence: e.confidence,
    last_verified_at: now,
    is_stale: false,
    location_name: e.venue.name,
    location: null,
  };
  if (!venueId) {
    if (e.venue.lat == null || e.venue.lng == null) return null;
    base.location = point(e.venue.lat, e.venue.lng);
    base.confidence = Math.min(e.confidence, 0.8);
  }
  return base;
}

async function upsertRows(rows: Row[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await db().from("happenings").upsert(chunk, { onConflict: "external_id" });
    if (error) throw new Error(`happenings upsert: ${error.message}`);
    n += chunk.length;
  }
  return n;
}

function dedupe(events: RawEvent[]): RawEvent[] {
  return [...new Map(events.map((e) => [e.externalId, e])).values()];
}

/** city_at() with an in-memory cache (per invocation), keyed on ~10 m rounded coordinates. */
function makeCityCheck(ctx: JobCtx): CityCheck {
  const memo = new Map<string, Promise<{ id: string; name: string } | null>>();
  return (lat, lng) => {
    const k = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    let p = memo.get(k);
    if (!p) {
      inc(ctx, "city_at_lookups");
      p = (async () => {
        const { data, error } = await db().rpc("city_at", { p_lat: lat, p_lng: lng });
        if (error) throw new Error(`city_at: ${error.message}`);
        const c = (data as { id: string; name: string; allowed: boolean }[] | null)?.[0];
        return c?.allowed ? { id: c.id, name: c.name } : null;
      })();
      memo.set(k, p);
    }
    return p;
  };
}

/** Resolve venues + upsert one adapter batch. Returns rows upserted. */
async function storeApiEvents(
  ctx: JobCtx, vi: VenueIndex, name: string, dataSource: string, events: RawEvent[], src: string | null,
  cityAt: CityCheck, dl: Deadline,
): Promise<{ upserted: number; partial: boolean }> {
  const now = new Date().toISOString();
  const rows: Row[] = [];
  let partial = false;
  for (const e of dedupe(events)) {
    // Geocoding new venues is the slow part; stop resolving (keep what we have) near the deadline.
    if (dl.left() < 6000) { partial = true; inc(ctx, `${name}_deferred`); continue; }
    const res = await vi.resolveTm(e, dataSource, cityAt);
    if (res.how === "outside") { inc(ctx, `${name}_skipped_outside`); continue; }
    inc(ctx, `${name}_venue_${res.how}`);
    const row = toRow(e, res.venueId, src, now);
    if (row) rows.push(row); else inc(ctx, `${name}_skipped_no_place`);
  }
  const upserted = await upsertRows(rows);
  inc(ctx, `${name}_upserted`, upserted);
  inc(ctx, `${name}_matched`, rows.filter((r) => r.venue_id).length);
  return { upserted, partial };
}

async function runSeatGeek(ctx: JobCtx, vi: VenueIndex, days: number, dl: Deadline, cityAt: CityCheck) {
  const src = await sourceId("seatgeek", SG_URL);
  try {
    const { events, stats } = await fetchSeatGeek({ days, dl, log: ctx.log });
    Object.assign(ctx.counts, stats);
    const { upserted } = await storeApiEvents(ctx, vi, "sg", "seatgeek", events, src, cityAt, dl);
    await markSource(src, `ok ${upserted}`);
  } catch (e) {
    ctx.counts.sg_error = String(e).slice(0, 300);
    await markSource(src, `error ${String(e).slice(0, 200)}`);
  }
}

/** Cities to pull from Ticketmaster, oldest last pull first, with their sources row id. */
async function tmCities(cityId: string | null, minAgeH: number): Promise<{ city: TmCity; src: string | null; last: string | null }[]> {
  let cities: TmCity[];
  if (cityId) {
    const { data, error } = await db().rpc("city_for_sync", { p_city_id: cityId });
    if (error) throw new Error(`city_for_sync: ${error.message}`);
    cities = (data ?? []) as TmCity[];
    if (!cities.length) throw new Error(`unknown city_id ${cityId}`);
  } else {
    const { data, error } = await db().rpc("active_cities");
    if (error) throw new Error(`active_cities: ${error.message}`);
    cities = (data ?? []) as TmCity[];
  }
  if (!cities.length) return [];
  const urls = cities.map((c) => `tm:${c.id}`);
  const { data: existing } = await db().from("sources").select("id,url,last_run_at")
    .eq("kind", "ticketmaster").in("url", urls);
  const byUrl = new Map((existing ?? []).map((r) => [r.url as string, r]));
  const out = [];
  for (const c of cities) {
    const ex = byUrl.get(`tm:${c.id}`);
    const src = ex?.id ?? await sourceId("ticketmaster", `tm:${c.id}`, { city_id: c.id, city: c.name });
    out.push({ city: c, src, last: (ex?.last_run_at as string | null) ?? null });
  }
  const cutoff = Date.now() - minAgeH * 3600_000;
  return out
    .filter((x) => cityId || !x.last || Date.parse(x.last) < cutoff)
    .sort((a, b) => (a.last ? Date.parse(a.last) : 0) - (b.last ? Date.parse(b.last) : 0));
}

async function runTicketmaster(
  ctx: JobCtx, vi: VenueIndex, days: number, dl: Deadline, cityAt: CityCheck, cityId: string | null, minAgeH: number,
) {
  let queue: Awaited<ReturnType<typeof tmCities>>;
  try {
    queue = await tmCities(cityId, minAgeH);
  } catch (e) {
    ctx.counts.tm_error = String(e).slice(0, 300);
    return;
  }
  ctx.counts.tm_cities_due = queue.length;
  const seen = new Set<string>();
  const done: string[] = [];
  let failed = 0;
  for (const [i, { city, src }] of queue.entries()) {
    // A city costs ~1-5 API pages (>=250 ms apart) plus venue resolution; keep headroom for the tail.
    if (dl.left() < 25000) { ctx.counts.tm_cities_deferred = queue.length - i; break; }
    try {
      const { events, stats } = await fetchTicketmaster({ days, dl, log: ctx.log, city });
      for (const [k, v] of Object.entries(stats)) inc(ctx, k, v);
      const fresh = events.filter((e) => !seen.has(e.externalId));
      for (const e of events) seen.add(e.externalId);
      inc(ctx, "tm_dup_across_cities", events.length - fresh.length);
      const { upserted, partial } = await storeApiEvents(ctx, vi, "tm", "ticketmaster", fresh, src, cityAt, dl);
      if (partial) {
        // Leave last_run_at alone so this city is first in line next run (resolved venues are cached).
        if (src) await db().from("sources").update({ last_status: `partial ${upserted}/${events.length}` }).eq("id", src);
      } else {
        await markSource(src, `ok ${upserted}/${events.length}`);
      }
      done.push(`${city.name}:${upserted}`);
      if (!cityId) await db().rpc("refresh_city_counts", { p_city_id: city.id }); // city_id runs refresh at the end
    } catch (e) {
      failed++;
      inc(ctx, "tm_city_errors");
      ctx.counts.tm_last_city_fail = `${city.name}: ${String(e).slice(0, 250)}`;
      await markSource(src, `error ${String(e).slice(0, 200)}`);
      // Quota/rate exhausted or bad key: no point trying the remaining cities now.
      if ((e as { rateLimited?: boolean }).rateLimited || /Ticketmaster 40[13]|not set/.test(String(e))) break;
    }
  }
  ctx.counts.tm_cities_done = done.join(", ");
  if (failed && !done.length) ctx.counts.tm_error = String(ctx.counts.tm_last_city_fail);
}

async function runWwoz(ctx: JobCtx, vi: VenueIndex, days: number, dl: Deadline) {
  const src = await sourceId("wwoz", WWOZ_CALENDAR);
  try {
    const { byDate, stats } = await fetchWwoz({ days, dl, log: ctx.log });
    Object.assign(ctx.counts, stats);
    const all = [...byDate.values()].flat().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (!all.length) { await markSource(src, "no events parsed"); return; }

    // Existing Ticketmaster rows in the same window: skip WWOZ duplicates (same venue, start within 60 min).
    const minT = all[0].startsAt, maxT = all[all.length - 1].startsAt;
    const { data: tmRows } = await db().from("happenings").select("venue_id, starts_at")
      .like("external_id", "tm:%").gte("starts_at", new Date(Date.parse(minT) - 3600000).toISOString())
      .lte("starts_at", new Date(Date.parse(maxT) + 3600000).toISOString());
    const tmByVenue = new Map<string, number[]>();
    for (const r of tmRows ?? []) {
      if (!r.venue_id) continue;
      tmByVenue.set(r.venue_id, [...(tmByVenue.get(r.venue_id) ?? []), Date.parse(r.starts_at)]);
    }

    const now = new Date().toISOString();
    const rows: Row[] = [];
    const dupIds: string[] = [];
    for (const e of all) {
      const res = await vi.resolveWwoz(e, dl, ctx.counts);
      inc(ctx, `wwoz_venue_${res.how}`);
      if (!res.venueId) continue;
      const t = Date.parse(e.startsAt);
      if ((tmByVenue.get(res.venueId) ?? []).some((x) => Math.abs(x - t) <= 3600000)) {
        inc(ctx, "wwoz_dup_of_tm");
        dupIds.push(e.externalId);
        continue;
      }
      const row = toRow(e, res.venueId, src, now);
      if (row) rows.push(row);
    }
    ctx.counts.wwoz_upserted = await upsertRows(rows);
    ctx.counts.wwoz_matched = rows.length;

    // Remove rows for fetched dates that are no longer listed (cancelled/edited) or duplicate TM.
    const keep = new Set(all.map((e) => e.externalId));
    for (const date of byDate.keys()) {
      if (!byDate.get(date)!.length) continue;
      const { data: existing } = await db().from("happenings").select("id, external_id")
        .like("external_id", `wwoz:${date}:%`);
      const gone = (existing ?? []).filter((r) => !keep.has(r.external_id) || dupIds.includes(r.external_id))
        .map((r) => r.id);
      if (gone.length) {
        await db().from("happenings").delete().in("id", gone);
        inc(ctx, "wwoz_removed", gone.length);
      }
    }
    await markSource(src, `ok ${rows.length}/${all.length}`);
  } catch (e) {
    ctx.counts.wwoz_error = String(e).slice(0, 300);
    await markSource(src, `error ${String(e).slice(0, 200)}`);
  }
}

serveJob("events_sync", async (ctx) => {
  const p = ctx.params;
  const adapters = Array.isArray(p.adapters)
    ? (p.adapters as string[])
    : typeof p.adapters === "string" ? String(p.adapters).split(",") : ["ticketmaster", "wwoz", "seatgeek"];
  const days = Math.min(7, Math.max(1, Number(p.days ?? 3)));
  const tmDays = Math.min(30, Math.max(1, Number(p.tm_days ?? 14)));
  const dl = deadline(Number(p.budget_ms ?? 110000));
  const cityId = p.city_id ? String(p.city_id) : null;
  const minAgeH = Math.max(0, Number(p.tm_min_age_h ?? 5));
  const cityAt = makeCityCheck(ctx);

  const vi = new VenueIndex();
  await vi.load();
  ctx.counts.venues_loaded = vi.venues.length;
  ctx.counts.venues_merged = await vi.mergeCreatedDuplicates();

  if (adapters.includes("ticketmaster")) await runTicketmaster(ctx, vi, tmDays, dl, cityAt, cityId, minAgeH);
  if (adapters.includes("seatgeek") && !cityId) await runSeatGeek(ctx, vi, tmDays, dl, cityAt);
  // WWOZ covers New Orleans only.
  if (adapters.includes("wwoz") && (!cityId || cityId === NOLA_CITY_ID)) await runWwoz(ctx, vi, days, dl);
  if (cityId) await db().rpc("refresh_city_counts", { p_city_id: cityId });

  ctx.counts.venues_created = vi.created;
  Object.assign(ctx.counts, geoStats);
  const { count } = await db().from("happenings").select("id", { count: "exact", head: true })
    .in("kind", ["live_music", "event"]).gte("starts_at", new Date().toISOString());
  ctx.counts.upcoming_events_total = count ?? 0;
  const errs = Object.keys(ctx.counts).filter((k) => k.endsWith("_error"));
  if (errs.length && errs.length === adapters.filter((a) => a !== "seatgeek").length) {
    throw new Error(`all adapters failed: ${errs.map((k) => ctx.counts[k]).join(" | ")}`);
  }
});
