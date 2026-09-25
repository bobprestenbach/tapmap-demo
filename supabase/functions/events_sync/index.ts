// events_sync: Ticketmaster + WWOZ Livewire (+ SeatGeek stub) -> happenings, matched to venues.
//
// Params (JSON body or query string):
//   adapters: ["ticketmaster","wwoz","seatgeek"]   (default: all; seatgeek no-ops unless ENABLE_SEATGEEK)
//   days:     WWOZ days to fetch starting today (default 3, max 7) — each page costs >=10 s (crawl delay)
//   tm_days:  Ticketmaster window in days (default 14)
//   budget_ms: time budget (default 110000)
//
// Other local listings: OffBeat (/events widget returns no rows; no public events API) and
// NOLA.com / Gambit (calendar is a JS-rendered third-party widget) are intentionally skipped.
import { serveJob, inc, JobCtx } from "../_shared/job.ts";
import { db } from "../_shared/db.ts";
import { point } from "../_shared/geo.ts";
import { deadline, Deadline, RawEvent } from "./types.ts";
import { VenueIndex } from "./venues.ts";
import { geoStats } from "./geocode.ts";
import { fetchTicketmaster } from "./ticketmaster.ts";
import { fetchWwoz, WWOZ_CALENDAR } from "./wwoz.ts";
import { fetchSeatGeek } from "./seatgeek.ts";

const TM_URL = "https://app.ticketmaster.com/discovery/v2/events.json";
const SG_URL = "https://api.seatgeek.com/2/events";

async function sourceId(kind: string, url: string): Promise<string | null> {
  const { data, error } = await db().from("sources")
    .upsert({ kind, url, cadence: "6h" }, { onConflict: "kind,url" }).select("id").single();
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

async function runApiAdapter(
  ctx: JobCtx, vi: VenueIndex, name: string, kind: string, url: string, dataSource: string,
  fetcher: () => Promise<{ events: RawEvent[]; stats: Record<string, number | string> }>,
) {
  const src = await sourceId(kind, url);
  try {
    const { events, stats } = await fetcher();
    Object.assign(ctx.counts, stats);
    const now = new Date().toISOString();
    const rows: Row[] = [];
    for (const e of dedupe(events)) {
      const res = await vi.resolveTm(e, dataSource);
      inc(ctx, `${name}_venue_${res.how}`);
      const row = toRow(e, res.venueId, src, now);
      if (row) rows.push(row); else inc(ctx, `${name}_skipped_no_place`);
    }
    ctx.counts[`${name}_upserted`] = await upsertRows(rows);
    ctx.counts[`${name}_matched`] = rows.filter((r) => r.venue_id).length;
    await markSource(src, `ok ${rows.length}`);
  } catch (e) {
    ctx.counts[`${name}_error`] = String(e).slice(0, 300);
    await markSource(src, `error ${String(e).slice(0, 200)}`);
  }
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

  const vi = new VenueIndex();
  await vi.load();
  ctx.counts.venues_loaded = vi.venues.length;

  if (adapters.includes("ticketmaster")) {
    await runApiAdapter(ctx, vi, "tm", "ticketmaster", TM_URL, "ticketmaster",
      () => fetchTicketmaster({ days: tmDays, dl, log: ctx.log }));
  }
  if (adapters.includes("seatgeek")) {
    await runApiAdapter(ctx, vi, "sg", "seatgeek", SG_URL, "seatgeek",
      () => fetchSeatGeek({ days: tmDays, dl, log: ctx.log }));
  }
  if (adapters.includes("wwoz")) await runWwoz(ctx, vi, days, dl);

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
