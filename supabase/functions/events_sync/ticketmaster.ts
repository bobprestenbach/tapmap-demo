// Ticketmaster Discovery API adapter: events around one city's center for the next N days.
// The radius scales with the city's area. No city-name filter here: the caller keeps an event only when its
// venue point lies inside an allowed city polygon (rpc city_at), so suburbs/nearby towns are handled uniformly.
// Rate limits: 5 req/s and 5000/day per key -> >=250 ms between calls (module-wide, across cities).
import { chicagoToUtc, haversineM } from "../_shared/geo.ts";
import { Deadline, RawEvent, sleep } from "./types.ts";

const BASE = "https://app.ticketmaster.com/discovery/v2/events.json";

// deno-lint-ignore no-explicit-any
type TmEvent = any;

export type TmCity = {
  id: string; name: string; lat: number; lng: number; area_km2: number | null;
  w?: number | null; s?: number | null; e?: number | null; n?: number | null;
};

/**
 * Query point + radius (miles). Base radius: clamp(round(sqrt(area_km2)/1.6/2)+5, 5, 25) around the Census
 * center. That center is an *internal point*, which for irregular cities can sit far from the core (New Orleans'
 * is in New Orleans East, ~10 mi from Uptown), so when the bbox is known we query from the bbox midpoint and make
 * sure the radius reaches the bbox corners (still capped at 25 mi).
 */
export function tmQuery(c: TmCity): { lat: number; lng: number; radius: number } {
  let lat = c.lat, lng = c.lng;
  let r = Math.round(Math.sqrt(Math.max(0, Number(c.area_km2 ?? 0))) / 1.6 / 2) + 5;
  if (c.w != null && c.s != null && c.e != null && c.n != null) {
    lat = (c.s + c.n) / 2;
    lng = (c.w + c.e) / 2;
    r = Math.max(r, Math.ceil(haversineM({ lat, lng }, { lat: c.n, lng: c.e }) / 1609.34));
  }
  return { lat: +lat.toFixed(5), lng: +lng.toFixed(5), radius: Math.min(25, Math.max(5, r)) };
}

let lastCall = 0;
async function tmFetch(u: URL): Promise<Response> {
  const wait = lastCall + 250 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return await fetch(u, { signal: AbortSignal.timeout(20000) });
}

function priceText(ranges?: { min?: number; max?: number; currency?: string }[]): string | null {
  const r = ranges?.find((x) => x.min != null) ?? ranges?.[0];
  if (!r || r.min == null) return null;
  const f = (n: number) => `$${Math.round(n)}`;
  if (r.max == null || Math.round(r.max) === Math.round(r.min)) return r.min === 0 ? "Free" : f(r.min);
  return `${f(r.min)}–${f(r.max)}`;
}

export async function fetchTicketmaster(
  opts: { days: number; dl: Deadline; log: (...a: unknown[]) => void; city: TmCity; maxPages?: number },
): Promise<{ events: RawEvent[]; stats: Record<string, number> }> {
  const key = Deno.env.get("TICKETMASTER_API_KEY");
  if (!key) throw new Error("TICKETMASTER_API_KEY not set");
  const start = new Date();
  const end = new Date(start.getTime() + opts.days * 86400000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const { lat: qLat, lng: qLng, radius } = tmQuery(opts.city);
  const stats = { tm_api_events: 0, tm_pages: 0, tm_skipped_cancelled: 0, tm_skipped_notime: 0 };
  const events: RawEvent[] = [];

  // Discovery caps deep paging at size*page < 1000 -> at most 5 pages of 200.
  for (let page = 0; page < Math.min(5, opts.maxPages ?? 5) && opts.dl.left() > 10000; page++) {
    const u = new URL(BASE);
    u.search = new URLSearchParams({
      apikey: key,
      latlong: `${qLat},${qLng}`,
      radius: String(radius), unit: "miles", size: "200", page: String(page),
      startDateTime: iso(start), endDateTime: iso(end), sort: "date,asc", locale: "*",
    }).toString();
    let r = await tmFetch(u);
    if (r.status === 429) { await sleep(1500); r = await tmFetch(u); }
    if (!r.ok) {
      const err = new Error(`Ticketmaster ${r.status}: ${(await r.text()).slice(0, 200)}`);
      if (r.status === 429) Object.assign(err, { rateLimited: true });
      throw err;
    }
    const data = await r.json();
    stats.tm_pages++;
    const list: TmEvent[] = data?._embedded?.events ?? [];
    stats.tm_api_events += list.length;

    for (const e of list) {
      const v = e._embedded?.venues?.[0];
      if (!v) continue;
      const status = e.dates?.status?.code;
      if (status === "cancelled" || status === "postponed") { stats.tm_skipped_cancelled++; continue; }
      const s = e.dates?.start ?? {};
      let startsAt: string | null = s.dateTime ?? null;
      if (!startsAt && s.localDate && s.localTime) startsAt = chicagoToUtc(s.localDate, s.localTime.slice(0, 5));
      if (!startsAt) { stats.tm_skipped_notime++; continue; }
      const endsAt: string | null = e.dates?.end?.dateTime ?? null;
      const cls = e.classifications?.find((c: TmEvent) => c.primary) ?? e.classifications?.[0];
      const segment = cls?.segment?.name ?? "";
      const genre = cls?.genre?.name && cls.genre.name !== "Undefined" ? cls.genre.name : null;
      const isMusic = segment === "Music";
      const venueName = String(v.name ?? "").trim();
      const vCity = String(v.city?.name ?? "").trim() || null;
      const vState = String(v.state?.stateCode ?? v.state?.name ?? "").trim() || null;
      const addr = [v.address?.line1, [vCity, vState].filter(Boolean).join(", ") || null, v.postalCode]
        .filter(Boolean).join(", ");
      const lat = v.location?.latitude ? +v.location.latitude : null;
      const lng = v.location?.longitude ? +v.location.longitude : null;
      events.push({
        externalId: `tm:${e.id}`,
        kind: isMusic ? "live_music" : "event",
        title: String(e.name).trim(),
        description: [genre ?? (segment && segment !== "Undefined" ? segment : null), `at ${venueName}`]
          .filter(Boolean).join(" · ") + (status === "offsale" ? " (tickets off sale online)" : ""),
        priceText: priceText(e.priceRanges),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        sourceUrl: e.url ?? `https://www.ticketmaster.com/event/${e.id}`,
        confidence: 0.95,
        venue: {
          key: `tm:${v.id}`, name: venueName, lat, lng, address: addr || null,
          city: vCity ?? opts.city.name, state: vState ?? "LA",
        },
      });
    }
    const totalPages = data?.page?.totalPages ?? 1;
    if (page + 1 >= totalPages) break;
  }
  flagSuspectCoords(events);
  opts.log("ticketmaster", opts.city.name, `r=${radius}mi`, stats);
  return { events, stats };
}

/**
 * Ticketmaster uses placeholder coordinates for some venues (several different venues sharing one point,
 * often with zero-padded decimals). Flag those so the venue resolver geocodes the address instead.
 */
export function flagSuspectCoords(events: RawEvent[]) {
  const namesAt = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.venue.lat == null) continue;
    const k = `${e.venue.lat},${e.venue.lng}`;
    namesAt.set(k, (namesAt.get(k) ?? new Set()).add(e.venue.key));
  }
  for (const e of events) {
    if (e.venue.lat == null) continue;
    if ((namesAt.get(`${e.venue.lat},${e.venue.lng}`)?.size ?? 0) > 1) e.venue.suspectCoords = true;
  }
}
