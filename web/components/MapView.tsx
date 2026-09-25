"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CATEGORIES, metaFor } from "@/lib/categories";
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
}

const SOURCE = "tm-points";

// See scripts/copy-maplibre-worker.mjs — the worker is served from /public/maplibre.
if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.origin).href);
}
const CAT_KEYS: Category[] = ["restaurant", "bar", "food_truck", "music_venue", "popup"];
const SOON_MS = 2 * 3600_000;

function styleUrl() {
  const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
  const style = process.env.NEXT_PUBLIC_MAPTILER_STYLE || "streets-v2-dark";
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

/** Palette tweaks so the MapTiler dark style sits closer to the TapMap navy/indigo reference. */
function tuneStyle(map: maplibregl.Map) {
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    try {
      if (layer.type === "background") {
        map.setPaintProperty(layer.id, "background-color", "#0d0c1c");
      } else if (layer.type === "fill" && /water/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "fill-color", "#0f1a33");
      } else if (layer.type === "line" && /^water|river|waterway/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "line-color", "#13213f");
      } else if (layer.type === "fill" && /(landcover|landuse|park|grass|wood)/i.test(layer.id)) {
        map.setPaintProperty(layer.id, "fill-opacity", 0.35);
      }
    } catch {
      /* layer may use expressions we don't override */
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
      minZoom: 9,
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
          inner.style.setProperty("--s", `${Math.min(56, 38 + Math.log2(count) * 3)}px`);
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
        clusterRadius: 44,
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
      readyRef.current = true;
      schedule();
      emitView();
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

  return <div ref={containerRef} className="tm-map" />;
}
