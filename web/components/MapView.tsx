"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CATEGORIES, metaFor } from "@/lib/categories";
import { CITY_MIN_ZOOM, CITY_PICK_MAX_ZOOM, citiesToGeoJSON, tooltipText, type CityInfo, type CityRow } from "@/lib/cities";
import type { Category, VenueGroup } from "@/lib/types";

export interface MapApi {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  focus: (lat: number, lng: number, bottomPadding: number) => void;
  getCenter: () => { lat: number; lng: number };
}

export interface ViewState {
  bounds: [number, number, number, number]; // w, s, e, n
  center: { lat: number; lng: number };
  zoom: number;
}

interface Props {
  center: { lat: number; lng: number };
  zoom: number;
  groups: VenueGroup[];
  userLoc: { lat: number; lng: number } | null;
  selectedKey: string | null;
  now: number;
  onSelect: (key: string) => void;
  onView: (v: ViewState) => void;
  onReady: (api: MapApi) => void;
  onError?: (msg: string) => void;
  cities: CityRow[];
  selectedCityId: string | null;
  /** Tap/click on a city outline (null = tapped empty map). */
  onCityPick: (c: CityInfo | null) => void;
}

const SOURCE = "tm-points";
const CITY_SOURCE = "tm-cities";
const CITY_FILL = "tm-city-fill";

const READY = "#67e8f9";
const LOADING = "#f0abfc";
const VIOLET = "#a78bfa";
const OUTSIDE = "#6d5fb0";
const cityColor = [
  "case",
  ["==", ["get", "allowed"], 0],
  OUTSIDE,
  ["match", ["get", "status"], "ready", READY, "queued", LOADING, "syncing", LOADING, VIOLET],
] as unknown as maplibregl.ExpressionSpecification;
const baseLineOpacity = [
  "case",
  ["==", ["get", "allowed"], 0],
  0.3,
  ["==", ["get", "status"], "ready"],
  0.7,
  0.42,
] as unknown as maplibregl.ExpressionSpecification;
const hot = ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]];

/** City outlines + fills, inserted under the basemap labels (markers are DOM, so always on top). */
function addCityLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  map.addSource(CITY_SOURCE, { type: "geojson", data, promoteId: "id" });
  const beforeId = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
  const fade = (v: unknown) =>
    ["interpolate", ["linear"], ["zoom"], 6.5, v, 12, v, 15, ["*", 0.45, v]] as unknown as maplibregl.ExpressionSpecification;
  map.addLayer(
    {
      id: CITY_FILL,
      type: "fill",
      source: CITY_SOURCE,
      paint: {
        "fill-color": cityColor,
        "fill-opacity": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          0.14,
          ["boolean", ["feature-state", "hover"], false],
          0.11,
          ["==", ["get", "status"], "ready"],
          0.03,
          0,
        ],
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: "tm-city-glow",
      type: "line",
      source: CITY_SOURCE,
      paint: {
        "line-color": cityColor,
        "line-width": 5,
        "line-blur": 4,
        "line-opacity": ["case", hot as maplibregl.ExpressionSpecification, 0.55, 0],
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: "tm-city-line",
      type: "line",
      source: CITY_SOURCE,
      filter: ["==", ["get", "allowed"], 1],
      paint: {
        "line-color": cityColor,
        "line-width": ["case", hot as maplibregl.ExpressionSpecification, 1.8, 0.9],
        "line-opacity": fade(baseLineOpacity),
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: "tm-city-line-out",
      type: "line",
      source: CITY_SOURCE,
      filter: ["==", ["get", "allowed"], 0],
      paint: {
        "line-color": OUTSIDE,
        "line-width": 0.8,
        "line-dasharray": [2, 2],
        "line-opacity": fade(0.32),
      },
    },
    beforeId,
  );
}

function featureToInfo(p: Record<string, unknown>): CityInfo {
  return {
    id: String(p.id),
    name: String(p.name),
    kind: p.kind ? String(p.kind) : null,
    status: String(p.status) as CityInfo["status"],
    phase: (p.phase ? String(p.phase) : null) as CityInfo["phase"],
    allowed: Number(p.allowed) === 1,
    venue_count: Number(p.venue_count ?? 0),
    happening_count: Number(p.happening_count ?? 0),
    lat: Number(p.lat),
    lng: Number(p.lng),
  };
}

// See scripts/copy-maplibre-worker.mjs — the worker is served from /public/maplibre.
if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.origin).href);
}
const CAT_KEYS: Category[] = ["restaurant", "bar", "food_truck", "music_venue", "popup"];
const SOON_MS = 2 * 3600_000;

function styleUrl() {
  const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
  const debugStyle =
    typeof window !== "undefined" && window.location.search.includes("debug=1")
      ? new URLSearchParams(window.location.search).get("style")
      : null;
  const style = debugStyle || process.env.NEXT_PUBLIC_MAPTILER_STYLE || "openstreetmap-dark";
  if (!key) {
    // Keyless fallback so the app still renders something in dev.
    return "https://demotiles.maplibre.org/style.json";
  }
  return `https://api.maptiler.com/maps/${style}/style.json?key=${key}`;
}

function toGeoJSON(groups: VenueGroup[], now: number): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: groups.map((g) => {
      const soon = !g.live && new Date(g.primary.occ_start).getTime() - now <= SOON_MS;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [g.lng, g.lat] },
        properties: {
          key: g.key,
          category: g.category,
          live: g.live ? 1 : 0,
          soon: soon ? 1 : 0,
          n: g.items.length,
        },
      };
    }),
  };
}

/** Palette tweaks so the MapTiler dark style sits closer to the TapMap navy/indigo reference:
 * muted streets, plum/pink highways, navy water, subdued parks. Unknown layers are left alone. */
function tuneStyle(map: maplibregl.Map) {
  const style = map.getStyle();
  if (!style?.layers) return;
  const set = (id: string, prop: string, value: string | number) => {
    try {
      map.setPaintProperty(id, prop as Parameters<typeof map.setPaintProperty>[1], value);
    } catch {
      /* property not applicable */
    }
  };
  for (const layer of style.layers) {
    const id = layer.id;
    const outline = /outline|casing/i.test(id);
    if (layer.type === "background") set(id, "background-color", "#101019");
    else if (layer.type === "fill" && /^water/i.test(id)) set(id, "fill-color", "#0f1a30");
    else if (layer.type === "line" && /river|waterway/i.test(id)) set(id, "line-color", "#13213d");
    else if (layer.type === "fill" && /park|grass|garden|wood|forest|recreation|cemetery|pitch|stadium|meadow/i.test(id))
      set(id, "fill-opacity", 0.55);
    else if (layer.type === "fill" && /commercial|retail|industrial|education|railway|military/i.test(id))
      set(id, "fill-opacity", 0.35);
    else if (layer.type === "line" && !outline) {
      if (/highway/i.test(id)) set(id, "line-color", "#723d50");
      else if (/trunk|primary/i.test(id)) set(id, "line-color", "#4a3141");
      else if (/secondary/i.test(id)) set(id, "line-color", "#393845");
      else if (/tertiary|minor|service|street/i.test(id)) set(id, "line-color", "#2c2b36");
    } else if (layer.type === "symbol") {
      const srcLayer = (layer as { "source-layer"?: string })["source-layer"];
      // Hide basemap POIs/house numbers — TapMap's own pins are the points of interest.
      if (srcLayer === "poi" || srcLayer === "housenumber" || srcLayer === "mountain_peak") map.setLayoutProperty(id, "visibility", "none");
      else if (/city|town|capital/i.test(id)) set(id, "text-color", "#9a93e6");
      else if (/road labels/i.test(id)) set(id, "text-color", "#9895ad");
    }
  }
}

function markerEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = `<div class="tm-marker"><span class="tm-emoji"></span><span class="tm-badge"></span></div>`;
  return el;
}

function clusterEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = `<div class="tm-cluster"><span></span></div>`;
  return el;
}

export default function MapView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const propsRef = useRef(props);
  const readyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const selCityRef = useRef<string | null>(null);

  useEffect(() => {
    propsRef.current = props;
  });

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const { center, zoom } = propsRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl(),
      center: [center.lng, center.lat],
      zoom,
      attributionControl: { compact: true },
      pitchWithRotate: false,
      dragRotate: false,
      maxZoom: 18,
      minZoom: 6.5,
      fadeDuration: 150,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    if (window.location.search.includes("debug=1")) (window as unknown as { __tmMap: unknown }).__tmMap = map;

    const emitView = () => {
      const b = map.getBounds();
      const c = map.getCenter();
      propsRef.current.onView({
        bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
        center: { lat: c.lat, lng: c.lng },
        zoom: map.getZoom(),
      });
    };

    const updateMarkers = () => {
      rafRef.current = null;
      if (!readyRef.current || !map.getSource(SOURCE)) return;
      const feats = map.querySourceFeatures(SOURCE);
      const seen = new Set<string>();
      const { selectedKey } = propsRef.current;
      for (const f of feats as MapGeoJSONFeature[]) {
        const p = f.properties as Record<string, unknown>;
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        const isCluster = Boolean(p.cluster);
        const id = isCluster ? `c:${p.cluster_id}` : `p:${p.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let marker = markersRef.current.get(id);
        if (!marker) {
          const el = isCluster ? clusterEl() : markerEl();
          marker = new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(map);
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const d = el.dataset;
            if (d.cluster) {
              const src = map.getSource(SOURCE) as GeoJSONSource;
              src
                .getClusterExpansionZoom(Number(d.cluster))
                .then((z) => map.easeTo({ center: marker!.getLngLat(), zoom: Math.min(z + 0.3, 17), duration: 500 }))
                .catch(() => {});
            } else if (d.key) {
              propsRef.current.onSelect(d.key);
            }
          });
          markersRef.current.set(id, marker);
        } else {
          marker.setLngLat(coords);
        }
        const el = marker.getElement();
        const inner = el.firstElementChild as HTMLElement;
        if (isCluster) {
          el.dataset.cluster = String(p.cluster_id);
          // Color the cluster by its dominant category.
          let best: Category = "music_venue";
          let bestN = -1;
          for (const c of CAT_KEYS) {
            const n = Number(p[`n_${c}`] ?? 0);
            if (n > bestN) {
              best = c;
              bestN = n;
            }
          }
          inner.style.setProperty("--c", CATEGORIES[best].color);
          inner.classList.toggle("live", Number(p.live_n ?? 0) > 0);
          const count = Number(p.point_count ?? 0);
          (inner.firstElementChild as HTMLElement).textContent = count > 99 ? "99+" : String(count);
          inner.style.setProperty("--s", `${Math.min(48, 34 + Math.log2(count) * 3)}px`);
          el.style.zIndex = "5";
        } else {
          const key = String(p.key);
          el.dataset.key = key;
          const meta = metaFor(String(p.category));
          inner.style.setProperty("--c", meta.color);
          (inner.firstElementChild as HTMLElement).textContent = meta.emoji;
          const badge = inner.lastElementChild as HTMLElement;
          const n = Number(p.n ?? 1);
          badge.textContent = n > 1 ? String(n) : "";
          badge.style.display = n > 1 ? "" : "none";
          const live = Number(p.live) === 1;
          inner.classList.toggle("live", live);
          inner.classList.toggle("soon", !live && Number(p.soon) === 1);
          inner.classList.toggle("later", !live && Number(p.soon) !== 1);
          inner.classList.toggle("selected", key === selectedKey);
          el.style.zIndex = key === selectedKey ? "20" : live ? "10" : "1";
          el.setAttribute("role", "button");
          el.setAttribute("aria-label", `${meta.label}: ${key}`);
        }
      }
      for (const [id, m] of markersRef.current) {
        if (!seen.has(id)) {
          m.remove();
          markersRef.current.delete(id);
        }
      }
    };

    const schedule = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(updateMarkers);
    };

    map.on("load", () => {
      tuneStyle(map);
      const clusterProperties: Record<string, unknown> = {
        live_n: ["+", ["get", "live"]],
      };
      for (const c of CAT_KEYS) {
        clusterProperties[`n_${c}`] = ["+", ["case", ["==", ["get", "category"], c], 1, 0]];
      }
      map.addSource(SOURCE, {
        type: "geojson",
        data: toGeoJSON(propsRef.current.groups, propsRef.current.now),
        cluster: true,
        clusterRadius: 30,
        clusterMaxZoom: 14,
        clusterProperties,
      });
      // Invisible layer so the source's tiles are built and queryable.
      map.addLayer({
        id: "tm-points-hidden",
        type: "circle",
        source: SOURCE,
        paint: { "circle-radius": 1, "circle-opacity": 0 },
      });
      addCityLayers(map, citiesToGeoJSON(propsRef.current.cities));
      readyRef.current = true;
      schedule();
      emitView();
    });

    // ---- city hover (desktop) + tap/click (all devices). DOM markers stop their own clicks.
    const tip = tipRef.current;
    let hoverId: string | null = null;
    const setHover = (id: string | null) => {
      if (id === hoverId) return;
      if (hoverId != null && map.getSource(CITY_SOURCE)) map.setFeatureState({ source: CITY_SOURCE, id: hoverId }, { hover: false });
      hoverId = id;
      if (id != null) map.setFeatureState({ source: CITY_SOURCE, id }, { hover: true });
      map.getCanvas().style.cursor = id != null ? "pointer" : "";
      if (id == null && tip) tip.style.opacity = "0";
    };
    const cityUnder = (point: maplibregl.PointLike): Record<string, unknown> | null => {
      if (!readyRef.current || !map.getLayer(CITY_FILL)) return null;
      const feats = map.queryRenderedFeatures(point, { layers: [CITY_FILL] });
      let best: Record<string, unknown> | null = null;
      for (const f of feats) {
        const p = f.properties as Record<string, unknown>;
        if (!best || Number(p.area) < Number(best.area)) best = p;
      }
      return best;
    };
    const canHover = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false;
    const pickable = () => map.getZoom() <= CITY_PICK_MAX_ZOOM && map.getZoom() >= CITY_MIN_ZOOM - 0.5;
    if (canHover) {
      map.on("mousemove", (e) => {
        const onCanvas = e.originalEvent.target === map.getCanvas();
        const p = onCanvas && pickable() ? cityUnder(e.point) : null;
        setHover(p ? String(p.id) : null);
        if (p && tip) {
          tip.textContent = tooltipText({
            name: String(p.name),
            status: String(p.status),
            allowed: Number(p.allowed),
            venue_count: Number(p.venue_count ?? 0),
          });
          tip.style.transform = `translate(${Math.round(e.point.x + 14)}px, ${Math.round(e.point.y + 16)}px)`;
          tip.style.opacity = "1";
        }
      });
      map.getCanvas().addEventListener("mouseleave", () => setHover(null));
      map.on("movestart", () => setHover(null));
    }
    map.on("click", (e) => {
      if (e.originalEvent.target !== map.getCanvas()) return;
      const p = pickable() ? cityUnder(e.point) : null;
      propsRef.current.onCityPick(p ? featureToInfo(p) : null);
    });
    map.on("render", schedule);
    map.on("moveend", emitView);
    map.on("error", (e: unknown) => {
      const msg = (e as { error?: Error }).error?.message;
      if (msg) propsRef.current.onError?.(msg);
    });

    propsRef.current.onReady({
      flyTo: (lat, lng, z) => map.flyTo({ center: [lng, lat], zoom: z ?? Math.max(map.getZoom(), 14), duration: 900 }),
      focus: (lat, lng, bottomPadding) =>
        map.easeTo({
          center: [lng, lat],
          zoom: Math.max(map.getZoom(), 14.5),
          padding: { top: 170, bottom: bottomPadding, left: 0, right: 0 },
          duration: 500,
        }),
      getCenter: () => {
        const c = map.getCenter();
        return { lat: c.lat, lng: c.lng };
      },
    });

    const markers = markersRef.current;
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      for (const m of markers.values()) m.remove();
      markers.clear();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData(toGeoJSON(props.groups, props.now));
    map.triggerRepaint();
  }, [props.groups, props.now]);

  // City outlines data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(CITY_SOURCE) as GeoJSONSource | undefined)?.setData(citiesToGeoJSON(props.cities));
  }, [props.cities]);

  // Selected city highlight (feature-state survives setData because ids are promoted).
  useEffect(() => {
    const map = mapRef.current;
    const id = props.selectedCityId;
    const apply = () => {
      if (!map || !map.getSource(CITY_SOURCE)) return;
      const prev = selCityRef.current;
      if (prev && prev !== id) map.setFeatureState({ source: CITY_SOURCE, id: prev }, { selected: false });
      if (id) map.setFeatureState({ source: CITY_SOURCE, id }, { selected: true });
      selCityRef.current = id;
    };
    if (map && readyRef.current) apply();
    else if (map) map.once("load", () => setTimeout(apply, 0));
  }, [props.selectedCityId, props.cities]);

  // Selection highlight.
  useEffect(() => {
    for (const [id, m] of markersRef.current) {
      if (!id.startsWith("p:")) continue;
      const inner = m.getElement().firstElementChild as HTMLElement;
      const sel = id === `p:${props.selectedKey}`;
      inner.classList.toggle("selected", sel);
      if (sel) m.getElement().style.zIndex = "20";
    }
  }, [props.selectedKey]);

  // User location dot.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!props.userLoc) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "tm-user";
      el.setAttribute("aria-label", "Your location");
      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([props.userLoc.lng, props.userLoc.lat]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([props.userLoc.lng, props.userLoc.lat]);
    }
  }, [props.userLoc]);

  return (
    <div className="tm-map">
      <div ref={containerRef} className="tm-map-inner" />
      <div ref={tipRef} className="tm-city-tip" aria-hidden="true" />
    </div>
  );
}
