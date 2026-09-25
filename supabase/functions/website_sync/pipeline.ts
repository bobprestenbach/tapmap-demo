// Website extraction pipeline (no DB access): fetch homepage + relevant subpages,
// convert to text, parse JSON-LD events, run LLM extraction, validate/normalize.
// Used by the website_sync edge function and by scripts/eval/website_eval.ts.
import { htmlToText, politeFetch, sha256 } from "../_shared/http.ts";
import { chicagoNow, chicagoToUtc, nameSimilarity } from "../_shared/geo.ts";
import { extractJsonWithUsage, Usage } from "./llm.ts";

export const KINDS = ["happy_hour", "special", "live_music", "event", "popup"] as const;
export type Kind = typeof KINDS[number];

export type Page = { url: string; status: number; chars: number; guessed?: boolean };

export type Item = {
  kind: Kind;
  title: string;
  description: string | null;
  price_text: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  starts_at: string | null;
  ends_at: string | null;
  date: string | null;
  confidence: number;
  evidence: string | null;
  evidence_found: "exact" | "fuzzy" | "missing" | "jsonld";
  source_url: string;
  key: string; // stable hash of kind+title+schedule (no venue id)
};

export type SiteResult = {
  status: string; // ok | unchanged | robots_blocked | http_XXX | not_html | no_text | no_schedule_text | llm_error | fetch_error
  pages: Page[];
  pagesFetched: number;
  robotsBlocked: number;
  text: string;
  hash: string | null;
  items: Item[];
  dropped: { reason: string; raw: unknown }[];
  llmCalled: boolean;
  usage: Usage | null;
  failedPages: string[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Fetching + link discovery
// ---------------------------------------------------------------------------
const MAX_HTML = 1_500_000;
const HOME_BUDGET = 5000, SUB_BUDGET = 7000, TOTAL_BUDGET = 17000;

const LINK_WEIGHTS: [RegExp, number][] = [
  [/happy[\s_-]*hour|\bhh\b/i, 12],
  [/special|deals?\b|promo/i, 9],
  [/events?\b|calendar|what'?s[\s_-]*(on|happening)|upcoming|schedule/i, 7],
  [/music|live\b|entertainment|jazz|band|shows?\b|lineup/i, 7],
  [/weekly|nightly|trivia|brunch/i, 4],
  [/drinks?|cocktails?|bar\b|beer|wine/i, 3],
  [/menus?\b|food/i, 2],
];
const LINK_BLOCK =
  /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mov)(\?|$)|^(mailto|tel|javascript|sms):|\/(cart|checkout|account|login|signin|register|wp-admin|wp-login|feed|tag|author)\b|gift[\s_-]*card|careers?|jobs|employment|privacy|terms|accessibility|press\b|shop\b|store\b|merch|donate|private[\s_-]*(events?|dining|parties)|book[\s_-]*(an?\s*)?event|catering|reservations?/i;

const baseHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

function normUrl(u: URL): string {
  const c = new URL(u.href);
  c.hash = "";
  let s = c.href;
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
}

export function discoverLinks(html: string, pageUrl: string, max = 3): string[] {
  const base = new URL(pageUrl);
  const scored = new Map<string, { url: string; score: number }>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (!href || href.startsWith("#")) continue;
    const label = [
      m[2].replace(/<[^>]+>/g, " "),
      attrs.match(/(?:aria-label|title)\s*=\s*["']([^"']+)["']/i)?.[1] ?? "",
    ].join(" ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 120);
    let u: URL;
    try { u = new URL(href.replace(/&amp;/g, "&"), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || baseHost(u.host) !== baseHost(base.host)) continue;
    const hay = `${label} ${decodeURIComponent(u.pathname)}`;
    if (LINK_BLOCK.test(u.href) || LINK_BLOCK.test(label)) continue;
    if (normUrl(u) === normUrl(base) || u.pathname === "/" || u.pathname === "") continue;
    let score = 0;
    for (const [rx, w] of LINK_WEIGHTS) if (rx.test(hay)) score += w;
    if (score <= 0) continue;
    const k = normUrl(u);
    const prev = scored.get(k);
    if (!prev || prev.score < score) scored.set(k, { url: u.href.replace(/#.*$/, ""), score });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.url);
}

function isSoft404(url: string, html: string): boolean {
  if (/\/404(\.\w+)?\/?$|not-found/i.test(new URL(url).pathname)) return true;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return /\b404\b|not found|page (can.t|cannot|could not) be found|nothing found/i.test(title);
}

const GUESS_PATHS = ["/happy-hour", "/specials", "/events"];

type Fetched = { url: string; html: string; status: number } | { url: string; blocked: true } | {
  url: string;
  status: number;
  error: string;
};

async function fetchHtml(url: string): Promise<Fetched> {
  try {
    const r = await politeFetch(url, { timeoutMs: 12000, minDelayMs: 1200 });
    if (!r) return { url, blocked: true };
    const ct = r.headers.get("content-type") ?? "";
    if (!r.ok) { await r.body?.cancel(); return { url: r.url || url, status: r.status, error: `http_${r.status}` }; }
    if (ct && !/html|xml/i.test(ct)) { await r.body?.cancel(); return { url: r.url || url, status: r.status, error: "not_html" }; }
    const html = (await r.text()).slice(0, MAX_HTML);
    return { url: r.url || url, html, status: r.status };
  } catch (e) {
    return { url, status: 0, error: `fetch_error: ${(e as Error).message.slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-LD Event parsing (no LLM needed)
// ---------------------------------------------------------------------------
function ldNodes(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) v.forEach((x) => ldNodes(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    out.push(o);
    if (o["@graph"]) ldNodes(o["@graph"], out);
    if (o["subEvent"]) ldNodes(o["subEvent"], out);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}

export function parseJsonLdEvents(html: string, pageUrl: string, today: string): Omit<Item, "key">[] {
  const out: Omit<Item, "key">[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const horizon = addDays(today, 60);
  while ((m = re.exec(html))) {
    let json: unknown;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of ldNodes(json)) {
      const t = ([] as unknown[]).concat(n["@type"] ?? []).map(String);
      if (!t.some((x) => /Event$/.test(x))) continue;
      const name = typeof n.name === "string" ? decodeEntities(n.name) : "";
      const sd = typeof n.startDate === "string" ? n.startDate : "";
      if (!name || !/T\d{2}:\d{2}/.test(sd)) continue; // need a time
      const start = new Date(sd);
      if (isNaN(+start)) continue;
      // If no explicit offset, treat as Chicago wall clock.
      const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(sd);
      // Chain sites list other cities' events: require a Central-time offset and a NOLA-ish address.
      if (hasTz && !/-0[56]:?00$/.test(sd)) continue;
      const loc = JSON.stringify(n.location ?? "");
      if (/addressLocality|addressRegion/.test(loc) && !/new orleans|nola|metairie|\bLA\b|louisiana/i.test(loc)) continue;
      const startsAt = hasTz ? start.toISOString() : chicagoToUtc(sd.slice(0, 10), sd.slice(11, 16));
      const localDate = hasTz ? chicagoDate(new Date(startsAt)) : sd.slice(0, 10);
      if (localDate < today || localDate > horizon) continue;
      let endsAt: string | null = null;
      if (typeof n.endDate === "string" && /T\d{2}:\d{2}/.test(n.endDate)) {
        const ed = n.endDate;
        const e = /(Z|[+-]\d{2}:?\d{2})$/.test(ed) ? new Date(ed).toISOString() : chicagoToUtc(ed.slice(0, 10), ed.slice(11, 16));
        const hrs = (+new Date(e) - +new Date(startsAt)) / 3600000;
        if (hrs > 0 && hrs <= 16) endsAt = e;
      }
      const music = t.some((x) => /Music/i.test(x)) || /live music|band|jazz|dj\b|concert/i.test(name);
      const desc = typeof n.description === "string" ? decodeEntities(n.description).slice(0, 300) : null;
      out.push({
        kind: music ? "live_music" : "event",
        title: name.slice(0, 120),
        description: desc,
        price_text: null,
        days_of_week: null,
        start_time: null,
        end_time: null,
        starts_at: startsAt,
        ends_at: endsAt,
        date: localDate,
        confidence: 0.9,
        evidence: `JSON-LD ${t[0]}: ${name} @ ${sd}`,
        evidence_found: "jsonld",
        source_url: typeof n.url === "string" && /^https?:/.test(n.url) ? n.url : pageUrl,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates / times
// ---------------------------------------------------------------------------
export function chicagoDate(d = new Date()): string {
  const p = chicagoNow(d);
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseTime(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/\./g, "");
  if (!s || /close|late|null|tbd|tba|varies/.test(s)) return null;
  if (s === "noon") return "12:00";
  if (s === "midnight") return "00:00";
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith("p") && h !== 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  }
  if (h === 24) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function parseDays(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const set = new Set<number>();
  for (const x of v) {
    if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 6) set.add(x);
    else if (typeof x === "number" && x === 7) set.add(0);
    else if (typeof x === "string") {
      const i = DAY_NAMES.indexOf(x.trim().toLowerCase().slice(0, 3));
      if (i >= 0) set.add(i);
      else if (/^[0-6]$/.test(x.trim())) set.add(+x.trim());
    }
  }
  return set.size ? [...set].sort((a, b) => a - b) : null;
}

// ---------------------------------------------------------------------------
// LLM prompt + validation
// ---------------------------------------------------------------------------
export const SYSTEM_PROMPT = `You extract happenings at ONE New Orleans hospitality venue (bar, restaurant, music venue) from text scraped from its own website.
Return ONLY a JSON object, no prose:
{"happenings":[{"kind":"happy_hour|special|live_music|event|popup","title":string,"description":string|null,"price_text":string|null,"days_of_week":[0-6]|null,"start_time":"HH:MM"|null,"end_time":"HH:MM"|null,"date":"YYYY-MM-DD"|null,"all_day":bool,"confidence":0-1,"evidence":string,"page":int}]}

Definitions:
- happy_hour: a happy hour / discounted drink window.
- special: a recurring food or drink deal tied to specific days (e.g. "$1 oysters Tuesdays 4-7pm", "Half-price wine Wednesdays 5pm-close").
- live_music: live bands, jazz, DJs - recurring (e.g. "Jazz brunch every Sunday 11am-2pm") or a dated show.
- event: trivia, bingo, comedy, drag, karaoke, parties, tastings, crawfish boils, etc. - recurring or dated.
- popup: a pop-up kitchen / vendor with a stated schedule.

Rules:
- Only extract things EXPLICITLY stated in the text. Never guess or invent days, times, dates or prices.
- Regular opening hours, kitchen hours and brunch service hours are NOT happenings (unless a specific deal or music is attached).
- Private events, catering, gift cards, reservations, and generic menu items are NOT happenings.
- Recurring items: days_of_week uses 0=Sunday..6=Saturday ("daily"/"every day" = all 7 days, "weekdays" = [1,2,3,4,5]); date=null.
- One-off items: date = the calendar date (YYYY-MM-DD); days_of_week=null. Skip anything dated before today. If a date omits the year, use the next occurrence on or after today. Skip one-offs more than 60 days out.
- Times are 24h "HH:MM" local New Orleans time. "4-7pm" = 16:00-19:00. "till close"/"late"/unstated end = end_time null. "10pm-2am" = start 22:00 end 02:00.
- A happy hour MUST have explicit days (or "daily") AND an explicit start time; otherwise omit it.
- Never borrow a time from a different item (e.g. do not give a day's drink special the happy-hour time). If a recurring deal is explicitly "all day", set "all_day": true and start_time/end_time null. Otherwise, a recurring item with no stated start time: start_time null.
- Weekly recurrence only in days_of_week. For monthly items ("first Saturday", "last Tuesday of the month") output the NEXT occurrence on or after today as a one-off with date (double-check the weekday). Omit every-other-week/biweekly items unless a specific date is given.
- One item per distinct schedule. If a happy hour has different times on different days, output one item per time window.
- title: short and specific (e.g. "Happy Hour", "$1 Oyster Tuesday", "Trivia Night", "Kermit Ruffins & the BBQ Swingers"). Do not include the venue name.
- description: one short sentence of what's offered (deal details), or null. price_text: prices/discounts as written (e.g. "$5 wells, half-off apps"), or null.
- evidence: a SHORT verbatim quote (max 150 chars) copied exactly from the text that states the schedule.
- page: the PAGE number the evidence came from.
- confidence: 0.9+ when days, times and offer are all clearly stated; 0.6-0.8 when some wording is ambiguous; below 0.5 if unsure.
- At most 25 items; prefer recurring happy hours/specials/music, then the soonest dated events.
- If nothing qualifies, return {"happenings":[]}.`;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9$]+/g, " ").trim();

function evidenceMatch(evidence: string, text: string): "exact" | "fuzzy" | "missing" {
  const e = norm(evidence), t = norm(text);
  if (!e) return "missing";
  if (t.includes(e)) return "exact";
  const toks = e.split(" ").filter((w) => w.length > 1);
  if (!toks.length) return "missing";
  const tset = new Set(t.split(" "));
  const hit = toks.filter((w) => tset.has(w)).length / toks.length;
  return hit >= 0.75 ? "fuzzy" : "missing";
}

export async function itemKey(i: Pick<Item, "kind" | "title" | "days_of_week" | "start_time" | "end_time" | "date" | "starts_at">): Promise<string> {
  const sched = i.date || i.starts_at
    ? `d:${i.starts_at ?? i.date}`
    : `r:${(i.days_of_week ?? []).join(",")}|${i.start_time}|${i.end_time ?? ""}`;
  return (await sha256(`${i.kind}|${norm(i.title)}|${sched}`)).slice(0, 16);
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function normalizeItems(
  raw: unknown,
  text: string,
  pageUrls: string[],
  today: string,
): Promise<{ items: Item[]; dropped: { reason: string; raw: unknown }[] }> {
  const arr = (raw as { happenings?: unknown })?.happenings;
  const items: Item[] = [];
  const dropped: { reason: string; raw: unknown }[] = [];
  if (!Array.isArray(arr)) return { items, dropped: [{ reason: "no_array", raw }] };
  const horizon = addDays(today, 60);
  for (const r of arr.slice(0, 30)) {
    const o = (r ?? {}) as Record<string, unknown>;
    const drop = (reason: string) => dropped.push({ reason, raw: r });
    let kind = String(o.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    if (kind === "music") kind = "live_music";
    if (kind === "pop_up") kind = "popup";
    if (!(KINDS as readonly string[]).includes(kind)) { drop("bad_kind"); continue; }
    const title = str(o.title, 120);
    if (!title) { drop("no_title"); continue; }
    let start = parseTime(o.start_time);
    let end = parseTime(o.end_time);
    if (start && end === start) end = null;
    const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
    let days = parseDays(o.days_of_week);
    let startsAt: string | null = null, endsAt: string | null = null;
    if (date) {
      if (date < today) { drop("past_date"); continue; }
      if (date > horizon) { drop("too_far"); continue; }
      if (!start && o.all_day === true && kind === "special" && ALL_DAY.test(String(o.evidence ?? ""))) { start = "00:00"; end = "23:59"; }
      if (!start) { drop("dated_no_time"); continue; }
      if (!monthlyDateOk(`${o.evidence ?? ""} ${o.description ?? ""}`, date)) { drop("monthly_date_mismatch"); continue; }
      startsAt = chicagoToUtc(date, start);
      if (end) endsAt = chicagoToUtc(end <= start ? addDays(date, 1) : date, end);
      days = null;
    } else {
      if (!days) { drop("no_days"); continue; }
      const blob = `${o.evidence ?? ""} ${o.description ?? ""} ${o.title ?? ""}`;
      if (MONTHLY.test(blob)) { drop("monthly_recurrence"); continue; }
      if (DATED.test(String(o.evidence ?? "")) && !WEEKLY.test(blob)) { drop("recurring_from_single_date"); continue; }
      if (!start && o.all_day === true && kind === "special" && ALL_DAY.test(String(o.evidence ?? ""))) {
        // Explicit "all day" deal: cover the whole day; UI shows it as all-day.
        start = "00:00"; end = "23:59";
        o.confidence = Math.min(Number(o.confidence ?? 0.7), 0.75);
      }
      if (!start) { drop("no_start_time"); continue; }
    }
    if (kind === "happy_hour" && !date && !end && !/close|late|end/i.test(String(o.evidence ?? "") + String(o.end_time ?? ""))) {
      // happy hour with a start but no stated end at all: keep but less sure
      o.confidence = Math.min(Number(o.confidence ?? 0.6), 0.6);
    }
    let conf = Number(o.confidence);
    if (!isFinite(conf)) conf = 0.6;
    conf = Math.max(0, Math.min(1, conf));
    const evidence = str(o.evidence, 300);
    const ev = evidence ? evidenceMatch(evidence, text) : "missing";
    // "Every day" is a common silent inference (e.g. from opening hours); trust it less unless stated.
    if (days?.length === 7 && !EVERY_DAY.test(`${evidence ?? ""} ${o.description ?? ""}`)) conf *= 0.75;
    if (ev === "fuzzy") conf *= 0.85;
    if (ev === "missing") conf *= 0.5;
    conf = Math.round(conf * 100) / 100;
    if (conf < 0.4) { drop("low_confidence"); continue; }
    const pageIdx = Number(o.page);
    const source_url = pageUrls[pageIdx - 1] ?? pageUrls[0];
    const base = {
      kind: kind as Kind, title, description: str(o.description, 300), price_text: str(o.price_text, 200),
      days_of_week: days, start_time: date ? null : start, end_time: date ? null : end,
      starts_at: startsAt, ends_at: endsAt, date, confidence: conf, evidence, evidence_found: ev, source_url,
    };
    items.push({ ...base, key: await itemKey(base) });
  }
  return { items, dropped };
}

const EVERY_DAY = /daily|every\s*day|everyday|7 days|seven days|nightly|every night|(sun|mon)\w*\s*(-|–|—|to|through|thru)\s*(sat|sun)\w*/i;
const ALL_DAY = /all[\s-]*day|all night|open to close/i;
const DATED = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b/i;
const WEEKLY = /\bevery\b|weekly|nightly|daily|each\b|(sun|mon|tues|wednes|thurs|fri|satur)days\b|\b(mon|tue|wed|thu|fri|sat|sun)\w*\s*[-–—]\s*(mon|tue|wed|thu|fri|sat|sun)/i;

const MONTHLY =
  /\b(monthly|every other|bi-?weekly|(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(sun|mon|tue|wed|thu|fri|sat)\w*)/i;

const ORD: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 };
/** If the text says e.g. "first Saturday" / "last Tuesday", check the model's computed date agrees. */
export function monthlyDateOk(text: string, date: string): boolean {
  const m = text.match(/\b(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(sun|mon|tue|wed|thu|fri|sat)\w*/i);
  if (!m) return true;
  const d = new Date(`${date}T12:00:00Z`);
  if (DAY_NAMES[d.getUTCDay()] !== m[2].toLowerCase().slice(0, 3)) return false;
  const n = ORD[m[1].toLowerCase()];
  const dom = d.getUTCDate();
  if (n === -1) {
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return dom + 7 > dim;
  }
  return Math.ceil(dom / 7) === n;
}

const SCHEDULE_HINT =
  /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\bnoon\b|\bmidnight\b|happy\s*hour|\b\d{1,2}:\d{2}\b|\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/i;

// ---------------------------------------------------------------------------
// Main entry: process one website
// ---------------------------------------------------------------------------
export async function processSite(
  homepage: string,
  opts: { venueName: string; prevHash?: string | null; forceLlm?: boolean; maxSubpages?: number; now?: Date },
): Promise<SiteResult> {
  const today = chicagoDate(opts.now);
  const res: SiteResult = {
    status: "ok", pages: [], pagesFetched: 0, robotsBlocked: 0, text: "", hash: null, items: [], dropped: [],
    llmCalled: false, usage: null, failedPages: [],
  };
  let url = homepage.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let home = await fetchHtml(url);
  if ("error" in home && home.error.startsWith("fetch_error")) {
    // DNS/TLS failures are often a www vs bare-host mismatch.
    const u = new URL(url);
    u.host = u.host.startsWith("www.") ? u.host.slice(4) : `www.${u.host}`;
    const alt = await fetchHtml(u.href);
    if (!("error" in alt)) home = alt;
  }
  if ("blocked" in home) { res.robotsBlocked++; res.status = "robots_blocked"; return res; }
  res.pagesFetched++;
  if ("error" in home) { res.status = home.error.startsWith("fetch_error") ? "fetch_error" : home.error; res.error = home.error; res.pages.push({ url, status: home.status, chars: 0 }); return res; }

  const htmls: { url: string; html: string; guessed?: boolean }[] = [{ url: home.url, html: home.html }];
  const maxSub = opts.maxSubpages ?? 3;
  const links = discoverLinks(home.html, home.url, maxSub);
  const homeText = htmlToText(home.html);
  // If nothing looks like a happy-hour/specials page, try a few conventional paths.
  const guesses: string[] = [];
  if (!links.some((l) => /happy|special/i.test(l)) && !/happy\s*hour/i.test(homeText)) {
    for (const p of GUESS_PATHS) {
      const g = new URL(p, home.url).href;
      if (!links.some((l) => normUrl(new URL(l)) === normUrl(new URL(g)))) guesses.push(g);
    }
  }
  const guessBudget = Math.max(1, maxSub - links.length);
  const toFetch = [
    ...links.map((u) => ({ u, guessed: false })),
    ...guesses.slice(0, guessBudget).map((u) => ({ u, guessed: true })),
  ];
  for (const { u, guessed } of toFetch) {
    const f = await fetchHtml(u);
    if ("blocked" in f) { res.robotsBlocked++; continue; }
    res.pagesFetched++;
    if ("error" in f) { if (!guessed) res.failedPages.push(`${u} (${f.error})`); continue; }
    if (htmls.some((h) => normUrl(new URL(h.url)) === normUrl(new URL(f.url)))) continue; // redirect to a page we have
    if (isSoft404(f.url, f.html)) continue;
    htmls.push({ url: f.url, html: f.html, guessed });
  }

  // Depth 2: a subpage (e.g. /menus) often links to the actual happy-hour page.
  const allHtml = htmls.map((h) => h.html).join("\n");
  if (!/happy\s*hour[^\n]{0,80}\d/i.test(htmlToText(allHtml))) {
    const fetched = new Set(htmls.map((h) => normUrl(new URL(h.url))));
    for (const p of htmls.slice(1)) {
      const hh = discoverLinks(p.html, p.url, 5).find((l) => /happy|special/i.test(l) && !fetched.has(normUrl(new URL(l))));
      if (!hh) continue;
      const f = await fetchHtml(hh);
      if ("blocked" in f) { res.robotsBlocked++; break; }
      res.pagesFetched++;
      if (!("error" in f) && !isSoft404(f.url, f.html)) htmls.push({ url: f.url, html: f.html });
      break;
    }
  }

  // Text assembly with cross-page line dedupe (drops repeated nav/footer).
  const seen = new Set<string>();
  const parts: string[] = [];
  const pageUrls: string[] = [];
  let total = 0;
  const ld: Omit<Item, "key">[] = [];
  for (const [i, p] of htmls.entries()) {
    ld.push(...parseJsonLdEvents(p.html, p.url, today));
    const lines = htmlToText(p.html).split("\n").map((l) => l.trim()).filter((l) => {
      if (l.length < 2) return false;
      const k = l.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    let t = lines.join("\n");
    const budget = Math.min(i === 0 ? HOME_BUDGET : SUB_BUDGET, TOTAL_BUDGET - total);
    if (budget < 300) break;
    t = t.slice(0, budget);
    total += t.length;
    pageUrls.push(p.url);
    res.pages.push({ url: p.url, status: 200, chars: t.length, guessed: p.guessed });
    parts.push(`### PAGE ${pageUrls.length}: ${p.url}\n${t}`);
  }
  res.text = parts.join("\n\n");
  const ldSig = ld.map((e) => `${e.title}@${e.starts_at}`).sort().join("\n");
  res.hash = await sha256(res.text + "\n#LD\n" + ldSig);

  // JSON-LD events never need the LLM.
  for (const e of ld) {
    const key = await itemKey({ ...e, title: `ld:${e.title}` });
    if (!res.items.some((x) => x.key === key)) res.items.push({ ...e, key });
  }

  if (!opts.forceLlm && opts.prevHash && opts.prevHash === res.hash) { res.status = "unchanged"; return res; }
  const bodyChars = res.text.replace(/^### PAGE.*$/gm, "").trim().length;
  if (bodyChars < 200) { res.status = res.items.length ? "ok" : "no_text"; return res; }
  if (!SCHEDULE_HINT.test(res.text)) { res.status = "no_schedule_text"; return res; }

  const dow = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const user = `Venue: ${opts.venueName}\nToday is ${dow} ${today} (America/Chicago).\n\n${res.text}`;
  res.llmCalled = true;
  try {
    const { data, usage } = await extractJsonWithUsage<unknown>(SYSTEM_PROMPT, user);
    res.usage = usage;
    const { items, dropped } = await normalizeItems(data, res.text, pageUrls, today);
    res.dropped = dropped;
    // Prefer the LLM's version of an event also present in JSON-LD (better kind/description).
    const sameEvent = (a: Item, b: Item) => a.starts_at === b.starts_at && nameSimilarity(a.title, b.title) >= 0.6;
    res.items = res.items.filter((ldItem) => !items.some((it) => it.starts_at && sameEvent(it, ldItem)));
    const have = new Set(res.items.map((i) => i.key));
    for (const it of items) if (!have.has(it.key)) { have.add(it.key); res.items.push(it); }
  } catch (e) {
    res.usage = (e as { usage?: Usage }).usage ?? null;
    res.status = "llm_error";
    res.error = (e as Error).message.slice(0, 300);
  }
  return res;
}
