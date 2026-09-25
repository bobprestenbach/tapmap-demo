// SeatGeek Platform API adapter — stub behind ENABLE_SEATGEEK (needs SEATGEEK_CLIENT_ID, not available yet).
// When enabled it produces the same RawEvent shape as the Ticketmaster adapter.
import { flag } from "../_shared/db.ts";
import { NOLA_CENTER } from "../_shared/geo.ts";
import { Deadline, RawEvent } from "./types.ts";

// deno-lint-ignore no-explicit-any
type SgEvent = any;

export async function fetchSeatGeek(
  opts: { days: number; dl: Deadline; log: (...a: unknown[]) => void },
): Promise<{ events: RawEvent[]; stats: Record<string, number | string> }> {
  const clientId = Deno.env.get("SEATGEEK_CLIENT_ID");
  if (!flag("ENABLE_SEATGEEK") || !clientId) {
    return { events: [], stats: { seatgeek: "disabled" } };
  }
  const now = new Date();
  const end = new Date(now.getTime() + opts.days * 86400000);
  const events: RawEvent[] = [];
  for (let page = 1; page <= 5 && opts.dl.left() > 10000; page++) {
    const u = new URL("https://api.seatgeek.com/2/events");
    u.search = new URLSearchParams({
      client_id: clientId,
      lat: String(NOLA_CENTER.lat), lon: String(NOLA_CENTER.lng), range: "15mi",
      "datetime_utc.gte": now.toISOString().slice(0, 19),
      "datetime_utc.lte": end.toISOString().slice(0, 19),
      per_page: "100", page: String(page),
    }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`SeatGeek ${r.status}`);
    const data = await r.json();
    const list: SgEvent[] = data.events ?? [];
    for (const e of list) {
      const v = e.venue ?? {};
      if ((v.city ?? "").toLowerCase() !== "new orleans" || !e.datetime_utc) continue;
      const isMusic = (e.taxonomies ?? []).some((t: SgEvent) => /concert|music/i.test(t.name ?? ""));
      const lo = e.stats?.lowest_price, hi = e.stats?.highest_price;
      events.push({
        externalId: `sg:${e.id}`,
        kind: isMusic ? "live_music" : "event",
        title: e.short_title ?? e.title,
        description: `at ${v.name}`,
        priceText: lo ? (hi && hi !== lo ? `$${lo}–$${hi}` : `$${lo}`) : null,
        startsAt: new Date(e.datetime_utc + "Z").toISOString(),
        endsAt: null,
        sourceUrl: e.url,
        confidence: 0.9,
        venue: { key: `sg:${v.id}`, name: v.name, lat: v.location?.lat ?? null, lng: v.location?.lon ?? null, address: v.address ?? null },
      });
    }
    if (list.length < 100) break;
  }
  return { events, stats: { seatgeek_events: events.length } };
}
