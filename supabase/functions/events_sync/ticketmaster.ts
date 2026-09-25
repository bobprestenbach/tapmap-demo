// Ticketmaster Discovery API adapter: events within ~15 miles of NOLA for the next N days.
// Only events at venues in the city of New Orleans are kept (Orleans Parish scope).
import { chicagoToUtc, NOLA_CENTER } from "../_shared/geo.ts";
import { Deadline, RawEvent, sleep } from "./types.ts";

const BASE = "https://app.ticketmaster.com/discovery/v2/events.json";

// deno-lint-ignore no-explicit-any
type TmEvent = any;

function priceText(ranges?: { min?: number; max?: number; currency?: string }[]): string | null {
  const r = ranges?.find((x) => x.min != null) ?? ranges?.[0];
  if (!r || r.min == null) return null;
  const f = (n: number) => `$${Math.round(n)}`;
  if (r.max == null || Math.round(r.max) === Math.round(r.min)) return r.min === 0 ? "Free" : f(r.min);
  return `${f(r.min)}–${f(r.max)}`;
}

export async function fetchTicketmaster(
  opts: { days: number; dl: Deadline; log: (...a: unknown[]) => void },
): Promise<{ events: RawEvent[]; stats: Record<string, number> }> {
  const key = Deno.env.get("TICKETMASTER_API_KEY");
  if (!key) throw new Error("TICKETMASTER_API_KEY not set");
  const start = new Date();
  const end = new Date(start.getTime() + opts.days * 86400000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const stats = { tm_api_events: 0, tm_pages: 0, tm_skipped_outside: 0, tm_skipped_cancelled: 0, tm_skipped_notime: 0 };
  const events: RawEvent[] = [];

  for (let page = 0; page < 5 && opts.dl.left() > 10000; page++) {
    const u = new URL(BASE);
    u.search = new URLSearchParams({
      apikey: key,
      latlong: `${NOLA_CENTER.lat},${NOLA_CENTER.lng}`,
      radius: "15", unit: "miles", size: "200", page: String(page),
      startDateTime: iso(start), endDateTime: iso(end), sort: "date,asc", locale: "*",
    }).toString();
    if (page > 0) await sleep(250); // stay well under 5 req/s
    let r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (r.status === 429) { await sleep(1500); r = await fetch(u, { signal: AbortSignal.timeout(20000) }); }
    if (!r.ok) throw new Error(`Ticketmaster ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    stats.tm_pages++;
    const list: TmEvent[] = data?._embedded?.events ?? [];
    stats.tm_api_events += list.length;

    for (const e of list) {
      const v = e._embedded?.venues?.[0];
      if (!v) continue;
      const city = (v.city?.name ?? "").toLowerCase();
      if (city !== "new orleans") { stats.tm_skipped_outside++; continue; }
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
      const addr = [v.address?.line1, "New Orleans, LA", v.postalCode].filter(Boolean).join(", ");
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
        venue: { key: `tm:${v.id}`, name: venueName, lat, lng, address: addr },
      });
    }
    const totalPages = data?.page?.totalPages ?? 1;
    if (page + 1 >= totalPages) break;
  }
  opts.log("ticketmaster", stats);
  return { events, stats };
}
