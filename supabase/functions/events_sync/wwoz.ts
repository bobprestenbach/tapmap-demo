// WWOZ Livewire Music Calendar adapter (https://www.wwoz.org/calendar/livewire-music?date=YYYY-MM-DD).
// robots.txt allows /calendar and /organizations for "*" with Crawl-delay: 10, so we wait >=10 s between
// requests to wwoz.org. One page per day lists every show that day, grouped by venue (no pagination).
import { chicagoNow, chicagoToUtc } from "../_shared/geo.ts";
import { politeFetch } from "../_shared/http.ts";
import { decodeEntities, Deadline, RawEvent, slugify } from "./types.ts";

export const WWOZ_CALENDAR = "https://www.wwoz.org/calendar/livewire-music";
const ORIGIN = "https://www.wwoz.org";
const CRAWL_DELAY_MS = 10500;

/** Chicago-local date string (YYYY-MM-DD) for today + offset days. */
export function chicagoDate(offsetDays = 0): string {
  const p = chicagoNow();
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offsetDays));
  return d.toISOString().slice(0, 10);
}

function to24h(h: number, m: number, ap: string): string {
  let hh = h % 12;
  if (ap.toLowerCase() === "pm") hh += 12;
  return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Parse one Livewire day page into events. Exported for testing. */
export function parseLivewire(html: string, date: string): RawEvent[] {
  const start = html.indexOf("livewire-listing");
  if (start < 0) return [];
  const body = html.slice(start);
  const panels = body.split(/<div class="panel panel-default">/).slice(1);
  const out: RawEvent[] = [];
  for (const panel of panels) {
    const head = panel.match(/<h3 class="panel-title">\s*<a href="\/organizations\/([^"]+)">([\s\S]*?)<\/a>/);
    if (!head) continue;
    const orgSlug = head[1];
    const venueName = decodeEntities(head[2]);
    const rowRe = /<a href="\/events\/(\d+)">([\s\S]*?)<\/a>\s*<\/p>\s*<p>([\s\S]*?)<\/p>/g;
    for (const m of panel.matchAll(rowRe)) {
      const eventId = m[1];
      const artist = decodeEntities(m[2].replace(/<[^>]+>/g, " "));
      const when = decodeEntities(m[3]);
      const t = when.match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
      if (!artist || !t) continue;
      const time = to24h(+t[1], +t[2], t[3]);
      out.push({
        externalId: `wwoz:${date}:${orgSlug}:${slugify(artist)}`,
        kind: "live_music",
        title: artist,
        description: `Live music at ${venueName} · WWOZ Livewire`,
        priceText: null,
        startsAt: chicagoToUtc(date, time),
        endsAt: null,
        sourceUrl: `${ORIGIN}/events/${eventId}`,
        confidence: 0.85,
        venue: { key: `wwoz:${orgSlug}`, name: venueName, orgUrl: `${ORIGIN}/organizations/${orgSlug}` },
      });
    }
  }
  // Same artist listed twice at one venue (e.g. two sets): keep the earliest, one pin per act.
  const seen = new Map<string, RawEvent>();
  for (const e of out) {
    const prev = seen.get(e.externalId);
    if (!prev || e.startsAt < prev.startsAt) seen.set(e.externalId, e);
  }
  return [...seen.values()];
}

export async function fetchWwoz(
  opts: { days: number; dl: Deadline; log: (...a: unknown[]) => void },
): Promise<{ byDate: Map<string, RawEvent[]>; stats: Record<string, number> }> {
  const byDate = new Map<string, RawEvent[]>();
  const stats = { wwoz_pages: 0, wwoz_parsed: 0, wwoz_page_errors: 0 };
  for (let i = 0; i < opts.days; i++) {
    // leave time for venue matching + upserts
    if (opts.dl.left() < 30000) break;
    const date = chicagoDate(i);
    const url = i === 0 ? WWOZ_CALENDAR : `${WWOZ_CALENDAR}?date=${date}`;
    try {
      const r = await politeFetch(url, { minDelayMs: CRAWL_DELAY_MS, timeoutMs: 20000 });
      if (!r) { opts.log("wwoz disallowed by robots", url); stats.wwoz_page_errors++; break; }
      if (!r.ok) { stats.wwoz_page_errors++; continue; }
      const html = await r.text();
      const cur = html.match(/data-current-date="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? date;
      const evs = parseLivewire(html, cur);
      stats.wwoz_pages++;
      stats.wwoz_parsed += evs.length;
      byDate.set(cur, evs);
    } catch (e) {
      stats.wwoz_page_errors++;
      opts.log("wwoz fetch error", url, String(e));
    }
  }
  opts.log("wwoz", stats);
  return { byDate, stats };
}
