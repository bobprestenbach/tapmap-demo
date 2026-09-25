// Parsing + normalisation helpers for trucks_sync (pure functions, no I/O).
import { chicagoNow } from "../_shared/geo.ts";

export type RawStop = {
  truck: string;
  kind?: "truck_stop" | "popup" | null;
  date?: string | null; // YYYY-MM-DD (Chicago) for one-offs
  days_of_week?: number[] | null; // 0=Sun..6=Sat for documented weekly schedules
  start?: string | null; // HH:MM 24h Chicago
  end?: string | null; // HH:MM 24h Chicago
  location_name?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  description?: string | null;
  confidence?: number | null;
};

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function decode(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** "10am", "11:30 am", "12pm", "12am" -> minutes after midnight (12am -> 24:00 when isEnd). */
export function parseClock(s: string, isEnd = false): number | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m?\.?$/);
  if (!m) {
    const h24 = s.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!h24) return null;
    const v = +h24[1] * 60 + +h24[2];
    return v === 0 && isEnd ? 1440 : v;
  }
  let h = +m[1] % 12;
  if (m[3] === "p") h += 12;
  let v = h * 60 + (m[2] ? +m[2] : 0);
  if (v === 0 && isEnd) v = 1440;
  return v;
}

export function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * Clamp a window to the plan's truck hours: 10:00 - 24:00 America/Chicago.
 * Returns [startMin, endMin] with endMin <= 1440, or null when nothing is left.
 */
export function clampWindow(startMin: number, endMin: number | null): [number, number] | null {
  let s = startMin, e = endMin ?? startMin + 180;
  if (e <= s) e = 1440; // crosses midnight -> cut at midnight
  if (s < 600) s = 600;
  if (e > 1440) e = 1440;
  if (s >= 1440 || e <= s) return null;
  return [s, e];
}

/** New Orleans Food Trucks association page (StreetFoodFinder "Who's Open" list, server-rendered). */
export function parseSff(html: string): RawStop[] {
  const out: RawStop[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<div id="post_').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf(">"));
    if (!/class="eve_row/.test(head)) continue;
    const attr = (k: string) => head.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? "";
    const id = head.match(/^(\d+)/)?.[1] ?? "";
    const st = +attr("st"), lat = +attr("lat"), lng = +attr("lng");
    if (!id || seen.has(id) || !st) continue;
    seen.add(id);
    const body = chunk.slice(0, 4000);
    const grab = (cls: string) => decode(body.match(new RegExp(`class="${cls}">([\\s\\S]*?)</(?:div|h3)>`))?.[1] ?? "");
    const name = grab("eve_name") || attr("tname");
    const cuisine = grab("eve_cuis");
    const st1 = grab("eve_st1"), st2 = grab("eve_st2"), time = grab("eve_time");
    const p = chicagoNow(new Date(st * 1000));
    const date = `${p.year}-${p.month}-${p.day}`;
    const startMin = (+p.hour % 24) * 60 + +p.minute;
    const parts = time.split(/\s*[-\u2013]\s*/);
    const endMin = parts[1] ? parseClock(parts[1], true) : null;
    out.push({
      truck: name,
      kind: "truck_stop",
      date,
      start: hhmm(startMin),
      end: endMin == null ? null : endMin >= 1440 ? "24:00" : hhmm(endMin),
      location_name: st1 || null,
      address: [st1, st2].filter(Boolean).join(", ") || null,
      lat: isFinite(lat) && lat ? lat : null,
      lng: isFinite(lng) && lng ? lng : null,
      description: cuisine || null,
      confidence: 0.9,
    });
  }
  return out;
}

type NtGig = { id: number; title: string; starts_at: string; ends_at: string | null; category: string | null; description?: string | null; artists?: { name?: string }[] };
type NtVenue = { name: string; lat: number; lng: number; slug: string; gigs: NtGig[] };

/** nola.today map.json — venues with gigs; only category === 'food' gigs are pop-ups/trucks. */
export function parseNolaToday(json: unknown): RawStop[] {
  const out: RawStop[] = [];
  if (!Array.isArray(json)) return out;
  for (const v of json as NtVenue[]) {
    for (const g of v.gigs ?? []) {
      if (g.category !== "food") continue;
      const s = new Date(g.starts_at);
      if (isNaN(+s)) continue;
      const p = chicagoNow(s);
      const e = g.ends_at ? chicagoNow(new Date(g.ends_at)) : null;
      out.push({
        truck: g.artists?.[0]?.name || g.title,
        kind: "popup",
        date: `${p.year}-${p.month}-${p.day}`,
        start: hhmm((+p.hour % 24) * 60 + +p.minute),
        end: e ? hhmm((+e.hour % 24) * 60 + +e.minute) : null,
        location_name: v.name,
        address: null,
        lat: v.lat, lng: v.lng,
        description: g.title !== (g.artists?.[0]?.name ?? "") ? g.title : null,
        confidence: 0.85,
      });
    }
  }
  return out;
}

/** Cheap check so we don't pay for an LLM call on pages with no schedule-like text. */
export function looksLikeSchedule(text: string): boolean {
  const day = /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?s?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\btoday\b|\btonight\b/i;
  const time = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b|\b\d{1,2}:\d{2}\b/i;
  return day.test(text) && time.test(text);
}

export const EXTRACT_SYSTEM = `You extract FOOD TRUCK and FOOD POP-UP schedule stops in the New Orleans area from web page text.
Return ONLY JSON: {"stops":[{"truck":string,"kind":"truck_stop"|"popup","date":"YYYY-MM-DD"|null,"days_of_week":[0-6]|null,"start":"HH:MM","end":"HH:MM"|null,"location_name":string|null,"address":string|null,"description":string|null,"confidence":0..1}]}
Rules:
- Only include stops the text explicitly states: a truck/pop-up at a place on a specific date, or an explicit weekly recurring schedule ("every Tuesday at X 5-9pm") -> days_of_week (0=Sunday..6=Saturday) with date null.
- "truck" = the vendor / pop-up / truck name, often inside an event title (e.g. "Hatch + Harvest & TNF Watch Party" -> "Hatch + Harvest"; "Jazzy Eggrolls Pop-up" -> "Jazzy Eggrolls"). If the text names no food vendor for an event, omit that event.
- Times are 24h America/Chicago wall clock. If no start time is stated, omit the stop.
- Resolve relative dates ("today", "this Friday") using TODAY given by the user. If a listing has no year, use the next occurrence on or after TODAY only if the listing plausibly refers to the upcoming weeks; omit clearly old/past listings. Never output dates before TODAY.
- kind "popup" for pop-up kitchens/dinners at bars, breweries, markets; "truck_stop" for food trucks/trailers.
- location_name = venue/place name (e.g. "Miel Brewery"); address if given. Ignore catering/private events, "book the truck", menus, and restaurant opening hours.
- Do not invent anything. If nothing qualifies return {"stops":[]}.`;

/** schema.org Event/FoodEvent objects embedded as JSON-LD -> stops (deterministic, no LLM). */
export function parseJsonLdEvents(html: string, fallbackTruck: string | null): RawStop[] {
  const out: RawStop[] = [];
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const visit = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const o = n as Record<string, unknown>;
    if (o["@graph"]) visit(o["@graph"]);
    const t = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
    if (!t.some((x) => /Event$/.test(x)) || typeof o.startDate !== "string") return;
    if (typeof o.eventStatus === "string" && /Cancelled|Postponed/i.test(o.eventStatus)) return;
    if (!/T\d{2}:\d{2}/.test(o.startDate)) return; // need a start time
    const s = new Date(o.startDate), e = typeof o.endDate === "string" ? new Date(o.endDate) : null;
    if (isNaN(+s)) return;
    const loc = (Array.isArray(o.location) ? o.location[0] : o.location) as Record<string, unknown> | undefined;
    const addr = loc?.address as Record<string, unknown> | string | undefined;
    const street = typeof addr === "string" ? addr
      : addr ? [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ") : "";
    const geo = loc?.geo as Record<string, unknown> | undefined;
    const org = (Array.isArray(o.organizer) ? o.organizer[0] : o.organizer) as Record<string, unknown> | undefined;
    const p = chicagoNow(s), pe = e && !isNaN(+e) ? chicagoNow(e) : null;
    const name = String(o.name ?? "");
    out.push({
      truck: fallbackTruck ?? String(org?.name ?? name),
      kind: /pop.?up/i.test(name + " " + String(o.description ?? "")) ? "popup" : null,
      date: `${p.year}-${p.month}-${p.day}`,
      start: hhmm((+p.hour % 24) * 60 + +p.minute),
      end: pe ? (pe.day !== p.day ? "24:00" : hhmm((+pe.hour % 24) * 60 + +pe.minute)) : null,
      location_name: loc?.name ? String(loc.name) : null,
      address: street || null,
      lat: geo?.latitude != null ? +geo.latitude : null,
      lng: geo?.longitude != null ? +geo.longitude : null,
      description: [name, typeof o.description === "string" ? o.description.slice(0, 200) : ""].filter(Boolean).join(" — ") || null,
      confidence: 0.85,
    });
  };
  for (const b of blocks) {
    try { visit(JSON.parse(b[1].trim())); } catch { /* ignore malformed JSON-LD */ }
  }
  return out;
}
