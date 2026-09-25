import { supabase } from "./supabase";
import type { Category, Happening } from "./types";
import { mockHappenings } from "./mock";

export const NOLA_CENTER = { lat: 29.9511, lng: -90.0715 };
export const FETCH_RADIUS_M = 12000;
/** Look-ahead so the app never looks empty: live now + anything starting in the next 12h. */
export const UPCOMING_WINDOW = "12 hours";
export const SOON_MS = 2 * 3600_000;

export async function fetchHappenings(opts: {
  lat: number;
  lng: number;
  categories: Category[];
  mock?: boolean;
}): Promise<Happening[]> {
  if (opts.mock) return mockHappenings(new Date(), opts.lat, opts.lng);
  const sb = supabase();
  if (!sb) throw new Error("Supabase is not configured");
  const { data, error } = await sb.rpc("happenings_near", {
    lat: opts.lat,
    lng: opts.lng,
    radius_m: FETCH_RADIUS_M,
    at: new Date().toISOString(),
    categories: opts.categories.length ? opts.categories : null,
    upcoming_window: UPCOMING_WINDOW,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Happening[]).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
}

export async function reportWrongInfo(happeningId: string, reason: string): Promise<void> {
  const sb = supabase();
  if (!sb) throw new Error("Supabase is not configured");
  const { error } = await sb.rpc("report_wrong_info", { p_happening_id: happeningId, p_reason: reason || null });
  if (error) throw new Error(error.message);
}

const CACHE_KEY = "tapmap:last-results";

export function saveCache(items: Happening[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items }));
  } catch {}
}

export function loadCache(): { at: number; items: Happening[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    // Drop cached rows that have already ended.
    const now = Date.now();
    v.items = (v.items as Happening[]).filter((h) => new Date(h.occ_end).getTime() > now);
    return v;
  } catch {
    return null;
  }
}
