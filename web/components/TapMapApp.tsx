"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, CHIP_ORDER, LIVE_COLOR, toggleCategory } from "@/lib/categories";
import { FETCH_RADIUS_M, NOLA_CENTER, SOON_MS, fetchHappenings, loadCache, saveCache } from "@/lib/data";
import { dedupe, findNeighborhood, groupByVenue, groupKey, matchesQuery } from "@/lib/group";
import { supabase } from "@/lib/supabase";
import { haversineM } from "@/lib/time";
import type { Category, Happening } from "@/lib/types";
import BottomSheet, { type SheetSection, type SheetState } from "./BottomSheet";
import DetailCard from "./DetailCard";
import { BroadcastIcon, LocateIcon, SearchIcon } from "./icons";
import type { MapApi, ViewState } from "./MapView";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="tm-map" /> });

const DEFAULT_ZOOM = 13.5;
const USER_ZOOM = 14;
const NEAR_NOLA_M = 25000;
const REFRESH_MS = 60_000;

type Status = "loading" | "ok" | "error" | "offline";
type LatLng = { lat: number; lng: number };

function useMockFlag(): boolean {
  // Only affects data loading (not initial markup), so reading the URL during init is hydration-safe.
  const [mock] = useState(
    () =>
      process.env.NEXT_PUBLIC_MOCK_DATA === "1" ||
      (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "1"),
  );
  return mock;
}

export default function TapMapApp() {
  const mock = useMockFlag();
  const [items, setItems] = useState<Happening[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [cats, setCats] = useState<Category[]>([]);
  const [liveOnly, setLiveOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [userLoc, setUserLoc] = useState<LatLng | null>(null);
  const [origin, setOrigin] = useState<LatLng>(NOLA_CENTER);
  const [view, setView] = useState<ViewState | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>("peek");
  const [now, setNow] = useState(() => Date.now());
  const mapApi = useRef<MapApi | null>(null);
  const pendingFly = useRef<LatLng | null>(null);
  const fetchSeq = useRef(0);

  // Clock tick for time labels / live state.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Show last cached results instantly (and when offline).
  useEffect(() => {
    const c = loadCache();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount
    if (c && c.items.length) setItems((prev) => (prev.length ? prev : c.items));
  }, []);

  // Geolocation: use it as the origin only when near New Orleans.
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    let first = true;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (haversineM(p.lat, p.lng, NOLA_CENTER.lat, NOLA_CENTER.lng) > NEAR_NOLA_M) return;
        setUserLoc(p);
        if (first) {
          first = false;
          setOrigin(p);
          if (mapApi.current) mapApi.current.flyTo(p.lat, p.lng, USER_ZOOM);
          else pendingFly.current = p;
        }
      },
      () => {},
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const load = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const rows = await fetchHappenings({ lat: origin.lat, lng: origin.lng, categories: cats, mock });
      if (seq !== fetchSeq.current) return;
      setItems(rows);
      setStatus("ok");
      setNow(Date.now());
      if (!mock) saveCache(rows);
    } catch {
      if (seq !== fetchSeq.current) return;
      setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
    }
  }, [origin, cats, mock]);

  // Fetch on filter/origin change + every 60s + when the tab becomes visible again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch synchronises with the server
    load();
    const t = setInterval(load, REFRESH_MS);
    const vis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", load);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", load);
    };
  }, [load]);

  // Realtime: refetch (debounced) when happenings are inserted/updated.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    if (mock) return;
    const sb = supabase();
    if (!sb) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadRef.current(), 2500);
    };
    const ch = sb
      .channel("happenings-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "happenings" }, bump)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "happenings" }, bump)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      sb.removeChannel(ch);
    };
  }, [mock]);

  // Items whose occurrence has ended since the last fetch drop out; live flag re-evaluated locally.
  const current = useMemo(() => {
    return dedupe(items)
      .filter((h) => new Date(h.occ_end).getTime() > now)
      .map((h) => {
        const live = new Date(h.occ_start).getTime() <= now;
        return live === h.is_live ? h : { ...h, is_live: live };
      });
  }, [items, now]);

  const hoodMatch = findNeighborhood(query);
  const filtered = useMemo(() => {
    const base = current.filter((h) => (cats.length === 0 || cats.includes(h.category)) && (!liveOnly || h.is_live));
    const text = base.filter((h) => matchesQuery(h, query));
    // A neighborhood name with no text hits just moves the map (on submit) instead of emptying it.
    return text.length === 0 && hoodMatch ? base : text;
  }, [current, cats, liveOnly, query, hoodMatch]);

  // Map shows live + starting-soon pins; later-tonight items stay in the list unless nothing sooner exists.
  const mapItems = useMemo(() => {
    const soon = filtered.filter((h) => h.is_live || new Date(h.occ_start).getTime() - now <= SOON_MS);
    return soon.length ? soon : filtered;
  }, [filtered, now]);
  const groups = useMemo(() => groupByVenue(mapItems), [mapItems]);
  // Groups for detail lookup include every item (so list taps on later items still open a card).
  const allGroups = useMemo(() => groupByVenue(filtered), [filtered]);
  const groupsByKey = useMemo(() => new Map(allGroups.map((g) => [g.key, g])), [allGroups]);
  const selected = selectedKey ? groupsByKey.get(selectedKey) ?? null : null;

  const inView = useCallback(
    (h: Happening) => {
      if (!view) return true;
      const [w, s, e, n] = view.bounds;
      return h.lng >= w && h.lng <= e && h.lat >= s && h.lat <= n;
    },
    [view],
  );

  const liveInView = useMemo(() => filtered.filter((h) => h.is_live && inView(h)).length, [filtered, inView]);

  const distanceFor = useCallback(
    (h: Happening) => (userLoc ? haversineM(userLoc.lat, userLoc.lng, h.lat, h.lng) : h.distance_m),
    [userLoc],
  );

  const sections: SheetSection[] = useMemo(() => {
    const byDist = (a: Happening, b: Happening) => distanceFor(a) - distanceFor(b);
    const live = filtered.filter((h) => h.is_live).sort(byDist);
    const soon = filtered
      .filter((h) => !h.is_live && new Date(h.occ_start).getTime() - now <= SOON_MS)
      .sort(byDist);
    const later = filtered
      .filter((h) => !h.is_live && new Date(h.occ_start).getTime() - now > SOON_MS)
      .sort((a, b) => new Date(a.occ_start).getTime() - new Date(b.occ_start).getTime() || byDist(a, b));
    return [
      { id: "live", title: "Live now", items: live },
      { id: "soon", title: "Starting soon", items: soon },
      { id: "later", title: "Later tonight · coming up", items: later },
    ];
  }, [filtered, distanceFor, now]);

  const liveTotal = sections[0].items.length;
  const upcomingTotal = sections[1].items.length + sections[2].items.length;
  const sheetTitle = liveTotal > 0 || status !== "ok" ? "Your city live" : "Quiet right now";
  const sheetSubtitle =
    status === "offline"
      ? "Offline — showing last update"
      : liveTotal > 0
        ? `${liveTotal} happening now · ${upcomingTotal} coming up`
        : upcomingTotal > 0
          ? "Here's what's coming up"
          : "Nothing nearby yet";

  const onView = useCallback((v: ViewState) => {
    setView(v);
    // Re-center the query when the map is panned far from the last fetch origin.
    setOrigin((o) => (haversineM(o.lat, o.lng, v.center.lat, v.center.lng) > FETCH_RADIUS_M / 2 ? v.center : o));
  }, []);

  const select = useCallback(
    (key: string) => {
      setSelectedKey(key);
      const g = groupsByKey.get(key);
      if (g) mapApi.current?.focus(g.lat, g.lng, Math.round(window.innerHeight * 0.55));
    },
    [groupsByKey],
  );

  const pick = useCallback((h: Happening) => select(groupKey(h)), [select]);

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hood = findNeighborhood(query);
    if (hood) mapApi.current?.flyTo(hood.lat, hood.lng, 15);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const effectiveNoResults = query && filtered.length === 0 && !hoodMatch;

  return (
    <main className="tm-app">
      <MapView
        center={origin}
        zoom={DEFAULT_ZOOM}
        groups={groups}
        userLoc={userLoc}
        selectedKey={selectedKey}
        now={now}
        onSelect={select}
        onView={onView}
        onReady={(api) => {
          mapApi.current = api;
          const p = pendingFly.current;
          pendingFly.current = null;
          if (p) api.flyTo(p.lat, p.lng, USER_ZOOM);
        }}
        onError={(msg) => console.warn("[map]", msg)}
      />

      <div className="tm-top">
        <header className="tm-header">
          <h1 className="tm-wordmark">TapMap</h1>
          <div className="tm-live-pill" aria-live="polite">
            <span className="tm-dot" />
            <span>
              <b>{liveInView}</b> live now
            </span>
          </div>
        </header>

        <form className="tm-search" onSubmit={onSearchSubmit} role="search">
          <SearchIcon />
          <input
            type="search"
            enterKeyHint="search"
            placeholder="What's poppin' near you?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search venues, events, neighborhoods"
          />
          {query && (
            <button type="button" className="tm-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              ×
            </button>
          )}
        </form>

        <div className="tm-chips" role="toolbar" aria-label="Filters">
          <button
            className={`tm-chip ${liveOnly ? "on" : ""}`}
            style={{ ["--c" as string]: LIVE_COLOR }}
            aria-pressed={liveOnly}
            onClick={() => setLiveOnly((v) => !v)}
          >
            <BroadcastIcon /> Live
          </button>
          {CHIP_ORDER.map((c) => {
            const m = CATEGORIES[c];
            const on = cats.includes(c);
            return (
              <button
                key={c}
                className={`tm-chip ${on ? "on" : ""}`}
                style={{ ["--c" as string]: m.color }}
                aria-pressed={on}
                onClick={() => setCats((s) => toggleCategory(s, c))}
              >
                <span className="tm-chip-emoji">{m.emoji}</span>
                {m.label}
              </button>
            );
          })}
        </div>
        {effectiveNoResults && <div className="tm-toast">No matches for “{query}”</div>}
      </div>

      {userLoc && (
        <button
          className="tm-locate"
          aria-label="Center on my location"
          onClick={() => mapApi.current?.flyTo(userLoc.lat, userLoc.lng, 15)}
        >
          <LocateIcon />
        </button>
      )}

      <BottomSheet
        state={sheet}
        onState={setSheet}
        title={sheetTitle}
        subtitle={sheetSubtitle}
        liveCount={liveTotal}
        sections={sections}
        status={status}
        now={new Date(now)}
        distanceFor={distanceFor}
        onPick={pick}
      />

      {selected && (
        <>
          <div className="tm-scrim" onClick={() => setSelectedKey(null)} />
          <DetailCard
            key={selected.key}
            group={selected}
            now={new Date(now)}
            mock={mock}
            distanceFor={distanceFor}
            onClose={() => setSelectedKey(null)}
          />
        </>
      )}
    </main>
  );
}
