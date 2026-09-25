import type { BBox, CityRow, CitySearchRow, CityStatus, CityStatusRow, RequestResult } from "./cities";

/** Demo city outlines for ?mock=1 (rough octagons, not real boundaries). */
type Seed = [id: string, name: string, kind: string, lat: number, lng: number, rKm: number, status: CityStatus, venues: number];
const SEEDS: Seed[] = [
  ["2255000", "New Orleans", "city", 29.99, -90.02, 13, "ready", 1240],
  ["2250115", "Metairie", "cdp", 30.0, -90.18, 6, "none", 0],
  ["2239475", "Kenner", "city", 30.02, -90.26, 4.5, "none", 0],
  ["2270805", "Slidell", "city", 30.28, -89.78, 4.5, "none", 0],
  ["2232755", "Hammond", "city", 30.5, -90.46, 4, "none", 0],
  ["2205000", "Baton Rouge", "city", 30.44, -91.13, 11, "ready", 610],
  ["2240735", "Lafayette", "city", 30.21, -92.03, 9, "none", 0],
  ["2241155", "Lake Charles", "city", 30.21, -93.2, 7, "none", 0],
  ["2236255", "Houma", "city", 29.59, -90.72, 5, "none", 0],
  ["2251410", "Monroe", "city", 32.51, -92.08, 7, "none", 0],
  ["2270000", "Shreveport", "city", 32.47, -93.79, 12, "none", 0],
];

const requested = new Map<string, number>();
const STEP_MS = 8000;

function octagon(lat: number, lng: number, rKm: number): GeoJSON.MultiPolygon {
  const dLat = rKm / 111;
  const dLng = rKm / (111 * Math.cos((lat * Math.PI) / 180));
  const ring: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const a = ((i % 8) / 8) * Math.PI * 2 + Math.PI / 8;
    ring.push([+(lng + Math.cos(a) * dLng).toFixed(5), +(lat + Math.sin(a) * dLat).toFixed(5)]);
  }
  return { type: "MultiPolygon", coordinates: [[ring]] };
}

function live(seed: Seed): { status: CityStatus; phase: CityRow["phase"]; venues: number } {
  const [id, , , , , , status, venues] = seed;
  const t = requested.get(id);
  if (t == null) return { status, phase: status === "ready" ? "done" : null, venues };
  const step = Math.floor((Date.now() - t) / STEP_MS);
  if (step >= 4) return { status: "ready", phase: "done", venues: 180 };
  if (step === 0) return { status: "queued", phase: "osm", venues: 0 };
  return { status: "syncing", phase: (["osm", "enrich", "events"] as const)[step - 1], venues: step * 55 };
}

function row(seed: Seed): CityRow {
  const [id, name, kind, lat, lng, rKm] = seed;
  const s = live(seed);
  return {
    id,
    name,
    kind,
    status: s.status,
    phase: s.phase,
    allowed: lat <= 32.4,
    hot: s.status === "ready",
    venue_count: s.venues,
    happening_count: Math.round(s.venues * 0.3),
    lat,
    lng,
    area_km2: Math.round(Math.PI * rKm * rKm),
    geojson: octagon(lat, lng, rKm),
  };
}

export function mockCitiesInView([w, s, e, n]: BBox): CityRow[] {
  return SEEDS.filter(([, , , lat, lng, r]) => {
    const d = r / 90;
    return lng + d >= w && lng - d <= e && lat + d >= s && lat - d <= n;
  })
    .map(row)
    .sort((a, b) => (b.area_km2 ?? 0) - (a.area_km2 ?? 0));
}

export function mockCityStatus(id: string): CityStatusRow | null {
  const seed = SEEDS.find((x) => x[0] === id);
  if (!seed) return null;
  const r = row(seed);
  return {
    id,
    name: r.name,
    status: r.status,
    phase: r.phase,
    allowed: r.allowed,
    venue_count: r.venue_count,
    happening_count: r.happening_count,
    last_error: null,
    requested_at: null,
    refreshed_at: null,
  };
}

export function mockRequestCity(id: string): RequestResult {
  const seed = SEEDS.find((x) => x[0] === id);
  if (!seed) return { ok: false, reason: "unknown_city" };
  const r = row(seed);
  if (!r.allowed) return { ok: false, status: r.status, reason: "outside_area" };
  if (r.status !== "none" && r.status !== "error") return { ok: true, status: r.status };
  requested.set(id, Date.now());
  return { ok: true, status: "queued" };
}

export function mockSearchCities(q: string, limit: number): CitySearchRow[] {
  const n = q.trim().toLowerCase();
  return SEEDS.filter((s) => s[1].toLowerCase().startsWith(n))
    .slice(0, limit)
    .map((s) => {
      const r = row(s);
      return { id: r.id, name: r.name, kind: r.kind, status: r.status, allowed: r.allowed, lat: r.lat, lng: r.lng };
    });
}
