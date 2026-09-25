// Point-in-polygon (ray casting) for GeoJSON Polygon / MultiPolygon in lng/lat order.
type Ring = number[][];
export type Geometry =
  | { type: "Polygon"; coordinates: Ring[] }
  | { type: "MultiPolygon"; coordinates: Ring[][] }
  | { type: string; coordinates?: unknown };

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and not inside any hole. */
function inPolygon(lng: number, lat: number, rings: Ring[]): boolean {
  if (!rings.length || !inRing(lng, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lng, lat, rings[k])) return false;
  return true;
}

export function pointInGeometry(lat: number, lng: number, g: Geometry | null | undefined): boolean {
  if (!g) return false;
  if (g.type === "Polygon") return inPolygon(lng, lat, g.coordinates as Ring[]);
  if (g.type === "MultiPolygon") return (g.coordinates as Ring[][]).some((p) => inPolygon(lng, lat, p));
  return false;
}
