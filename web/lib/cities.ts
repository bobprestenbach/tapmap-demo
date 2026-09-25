import { supabase } from "./supabase";
import { mockCitiesInView, mockCityStatus, mockRequestCity, mockSearchCities } from "./mock-cities";

export type CityStatus = "none" | "queued" | "syncing" | "ready" | "error";
export type CityPhase = "osm" | "enrich" | "events" | "done" | null;

/** One row of `cities_in_view`. */
export interface CityRow {
  id: string;
  name: string;
  kind: string | null;
  status: CityStatus;
  phase: CityPhase;
  allowed: boolean;
  hot: boolean;
  venue_count: number;
  happening_count: number;
  lat: number;
  lng: number;
  area_km2: number | null;
  geojson: GeoJSON.MultiPolygon | GeoJSON.Polygon;
}

/** What the city card needs; filled from cities_in_view, search_cities and/or city_status. */
export interface CityInfo {
  id: string;
  name: string;
  kind: string | null;
  status: CityStatus;
  phase: CityPhase;
  allowed: boolean;
  venue_count: number;
  happening_count: number;
  lat: number | null;
  lng: number | null;
  last_error?: string | null;
}

export interface CitySearchRow {
  id: string;
  name: string;
  kind: string | null;
  status: CityStatus;
  allowed: boolean;
  lat: number;
  lng: number;
}

export interface CityStatusRow {
  id: string;
  name: string;
  status: CityStatus;
  phase: CityPhase;
  allowed: boolean;
  venue_count: number;
  happening_count: number;
  last_error: string | null;
  requested_at: string | null;
  refreshed_at: string | null;
}

export type RequestReason = "unknown_city" | "outside_area" | "retry_later" | "busy" | "budget";
export interface RequestResult {
  ok: boolean;
  status?: CityStatus;
  reason?: RequestReason | string;
}

/** Outlines are fetched from this zoom up (below it the whole state is one screen and we keep what we have). */
export const CITY_MIN_ZOOM = 7;
/** Above this zoom a tap on the map no longer selects the city under it (you're browsing venues). */
export const CITY_PICK_MAX_ZOOM = 11.5;
export const NOLA_CITY_ID = "2255000";

/** Simplification tolerance (degrees) for cities_in_view by zoom. */
export function toleranceForZoom(zoom: number): number {
  if (zoom < 8) return 0.006;
  if (zoom < 10) return 0.003;
  if (zoom < 12) return 0.001;
  return 0.0003;
}

export type BBox = [number, number, number, number]; // w, s, e, n

/** Grow a bbox by `f` of its size on each side (so small pans don't refetch). */
export function padBBox([w, s, e, n]: BBox, f = 0.25): BBox {
  const dx = (e - w) * f;
  const dy = (n - s) * f;
  return [w - dx, s - dy, e + dx, n + dy];
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

// ---------------------------------------------------------------------------- geometry

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point-in-(Multi)Polygon with holes. */
export function pointInGeometry(lng: number, lat: number, g: GeoJSON.MultiPolygon | GeoJSON.Polygon): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    if (!poly.length || !inRing(lng, lat, poly[0])) continue;
    if (!poly.slice(1).some((hole) => inRing(lng, lat, hole))) return true;
  }
  return false;
}

/** Smallest city containing the point (Census places don't overlap, but be safe). */
export function cityAt(cities: CityRow[], lat: number, lng: number): CityRow | null {
  let best: CityRow | null = null;
  for (const c of cities) {
    if (!c.geojson || !pointInGeometry(lng, lat, c.geojson)) continue;
    if (!best || (c.area_km2 ?? Infinity) < (best.area_km2 ?? Infinity)) best = c;
  }
  return best;
}

export function citiesToGeoJSON(cities: CityRow[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cities
      .filter((c) => c.geojson)
      .map((c) => ({
        type: "Feature",
        id: c.id,
        geometry: c.geojson,
        properties: {
          id: c.id,
          name: c.name,
          kind: c.kind ?? "",
          status: c.status,
          phase: c.phase ?? "",
          allowed: c.allowed ? 1 : 0,
          venue_count: c.venue_count ?? 0,
          happening_count: c.happening_count ?? 0,
          lat: c.lat,
          lng: c.lng,
          area: c.area_km2 ?? 0,
        },
      })),
  };
}

// ---------------------------------------------------------------------------- labels

export const KIND_LABELS: Record<string, string> = {
  city: "City",
  town: "Town",
  village: "Village",
  cdp: "Community",
};

export function kindLabel(kind: string | null | undefined): string {
  return (kind && KIND_LABELS[kind]) || "Place";
}

export const PHASES: { id: Exclude<CityPhase, null | "done">; label: string }[] = [
  { id: "osm", label: "Finding bars & restaurants" },
  { id: "enrich", label: "Filling in details" },
  { id: "events", label: "Pulling events" },
];

/** 0-based index of the active phase (queued counts as the first step). */
export function phaseIndex(phase: CityPhase | undefined): number {
  const i = PHASES.findIndex((p) => p.id === phase);
  if (phase === "done") return PHASES.length;
  return i < 0 ? 0 : i;
}

export function phaseLabel(status: CityStatus, phase: CityPhase | undefined): string {
  if (status === "queued") return "Getting started";
  return PHASES[Math.min(phaseIndex(phase), PHASES.length - 1)].label;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export type CardView = "ready" | "load" | "progress" | "error" | "outside";

/** Which body the city card shows. */
export function cityCardView(c: Pick<CityInfo, "status" | "allowed">): CardView {
  if (c.status === "ready") return "ready";
  if (c.status === "queued" || c.status === "syncing") return "progress";
  if (!c.allowed) return "outside";
  if (c.status === "error") return "error";
  return "load";
}

export const OUTSIDE_MSG = "Outside the current coverage area (Louisiana south of Monroe)";

export function requestReasonMessage(reason: string | undefined | null): string {
  switch (reason) {
    case "busy":
      return "Lots of cities are loading right now — try again in a little while.";
    case "budget":
      return "We've hit this month's limit for loading new cities. Check back next month!";
    case "retry_later":
      return "We just tried this one — give it a few minutes and try again.";
    case "outside_area":
      return OUTSIDE_MSG;
    case "unknown_city":
      return "We couldn't find that city.";
    default:
      return "Couldn't start loading right now — try again in a bit.";
  }
}

/** Short hover tooltip for a city outline. */
export function tooltipText(c: { name: string; status: string; allowed: boolean | number; venue_count: number }): string {
  const allowed = Boolean(c.allowed);
  if (c.status === "ready") return `${c.name} · Ready${c.venue_count > 0 ? ` · ${plural(c.venue_count, "spot")}` : ""}`;
  if (c.status === "queued" || c.status === "syncing") return `${c.name} · Loading…`;
  if (!allowed) return `${c.name} · Outside coverage`;
  return `${c.name} · Tap to load`;
}

export function rowToInfo(c: CityRow | CitySearchRow): CityInfo {
  const r = c as Partial<CityRow> & CitySearchRow;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind ?? null,
    status: r.status,
    phase: r.phase ?? null,
    allowed: r.allowed,
    venue_count: r.venue_count ?? 0,
    happening_count: r.happening_count ?? 0,
    lat: r.lat ?? null,
    lng: r.lng ?? null,
  };
}

export function mergeStatus(info: CityInfo, s: CityStatusRow): CityInfo {
  return {
    ...info,
    name: s.name ?? info.name,
    status: s.status,
    phase: s.phase,
    allowed: s.allowed,
    venue_count: s.venue_count ?? info.venue_count,
    happening_count: s.happening_count ?? info.happening_count,
    last_error: s.last_error,
  };
}

// ---------------------------------------------------------------------------- RPCs

function sbOrThrow() {
  const sb = supabase();
  if (!sb) throw new Error("Supabase is not configured");
  return sb;
}

export async function fetchCitiesInView(bbox: BBox, zoom: number, mock = false): Promise<CityRow[]> {
  if (mock) return mockCitiesInView(bbox);
  const [w, s, e, n] = bbox;
  const { data, error } = await sbOrThrow().rpc("cities_in_view", { w, s, e, n, p_tol: toleranceForZoom(zoom) });
  if (error) throw new Error(error.message);
  return (data ?? []) as CityRow[];
}

export async function fetchCityStatus(id: string, mock = false): Promise<CityStatusRow | null> {
  if (mock) return mockCityStatus(id);
  const { data, error } = await sbOrThrow().rpc("city_status", { p_city_id: id });
  if (error) throw new Error(error.message);
  return ((data ?? []) as CityStatusRow[])[0] ?? null;
}

export async function requestCity(id: string, mock = false): Promise<RequestResult> {
  if (mock) return mockRequestCity(id);
  const { data, error } = await sbOrThrow().rpc("request_city", { p_city_id: id });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false }) as RequestResult;
}

export async function markCityViewed(id: string, mock = false): Promise<void> {
  if (mock) return;
  const { error } = await sbOrThrow().rpc("mark_city_viewed", { p_city_id: id });
  if (error) throw new Error(error.message);
}

export async function searchCities(q: string, limit = 5, mock = false): Promise<CitySearchRow[]> {
  if (q.trim().length < 2) return [];
  if (mock) return mockSearchCities(q, limit);
  const { data, error } = await sbOrThrow().rpc("search_cities", { q, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []) as CitySearchRow[];
}
