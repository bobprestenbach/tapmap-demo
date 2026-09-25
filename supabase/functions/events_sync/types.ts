// Shared types for events_sync adapters.

/** A normalized event produced by an adapter, before venue matching / upsert. */
export type RawEvent = {
  externalId: string;               // 'tm:<id>' | 'wwoz:<date>:<venue>:<artist>' | 'sg:<id>'
  kind: "live_music" | "event";
  title: string;
  description?: string | null;
  priceText?: string | null;
  startsAt: string;                 // ISO UTC
  endsAt?: string | null;           // null => RPC assumes 3h
  sourceUrl: string;
  confidence: number;
  venue: {
    key: string;                    // cache key, e.g. 'tm:<venueId>' / 'wwoz:<org-slug>'
    name: string;
    lat?: number | null;
    lng?: number | null;
    address?: string | null;
    orgUrl?: string | null;         // page with venue details (WWOZ organization page)
  };
};

export type Deadline = { endAt: number; left: () => number };

export function deadline(ms: number): Deadline {
  const endAt = Date.now() + ms;
  return { endAt, left: () => endAt - Date.now() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "-")
    .replace(/&nbsp;/g, " ").replace(/&eacute;/g, "é").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}

/** Rough Orleans Parish bounding box (East Bank + Algiers). Used as a sanity filter only. */
export function inOrleansBox(lat: number, lng: number): boolean {
  return lat >= 29.86 && lat <= 30.2 && lng >= -90.14 && lng <= -89.62;
}
