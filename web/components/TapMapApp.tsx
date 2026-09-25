"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, CHIP_ORDER, LIVE_COLOR, toggleCategory } from "@/lib/categories";
import {
  CITY_MIN_ZOOM,
  CITY_PICK_MAX_ZOOM,
  NOLA_CITY_ID,
  bboxContains,
  cityAt,
  fetchCitiesInView,
  fetchCityStatus,
  markCityViewed,
  mergeStatus,
  padBBox,
  requestCity,
  rowToInfo,
  searchCities,
  toleranceForZoom,
  type BBox,
  type CityInfo,
  type CityRow,
  type CitySearchRow,
} from "@/lib/cities";
import { FETCH_RADIUS_M, NOLA_CENTER, SOON_MS, fetchHappenings, loadCache, saveCache } from "@/lib/data";
import { dedupe, findNeighborhood, groupByVenue, groupKey, matchesQuery } from "@/lib/group";
import { supabase } from "@/lib/supabase";
import { haversineM } from "@/lib/time";
import type { Category, Happening } from "@/lib/types";
import BottomSheet, { type SheetSection, type SheetState } from "./BottomSheet";
import CityCard from "./CityCard";
import DetailCard from "./DetailCard";
import { BroadcastIcon, LocateIcon, SearchIcon } from "./icons";
import type { MapApi, ViewState } from "./MapView";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="tm-map" /> });

const DEFAULT_ZOOM = 13.5;
const USER_ZOOM = 14;
const REFRESH_MS = 60_000;
const CITY_POLL_MS = 5000;
const CITY_ZOOM = 13;

type Status = "loading" | "ok" | "error" | "offline";
type LatLng = { lat: number; lng: number };

function useMockFlag(): boolean {
  // Only affects data loading (not initial markup), so reading the URL during init is hydration-safe.
  const [mock] = useState(
    () =>
      process.env.NEXT_PUBLIC_MOCK_DATA === "1" ||
      // ?mock=1 only in dev builds, or when explicitly allowed (e.g. local screenshot runs).
      ((process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_MOCK_DATA === "allow") &&
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("mock") === "1"),
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
  const [cities, setCities] = useState<CityRow[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityInfo | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestReason, setRequestReason] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CitySearchRow[]>([]);
  const [searchFocus, setSearchFocus] = useState(false);
  const [citiesNonce, setCitiesNonce] = useState(0);
  const citiesFetched = useRef<{ bbox: BBox; tol: number; nonce: number } | null>(null);
  const viewedCities = useRef(new Set<string>());

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

  // Geolocation: use it as the origin wherever the user is (cities outside coverage just look empty).
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    let first = true;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
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

  // City outlines for the viewport (debounced; padded bbox so small pans don't refetch).
  useEffect(() => {
    if (!view || view.zoom < CITY_MIN_ZOOM) return;
    const tol = toleranceForZoom(view.zoom);
    const last = citiesFetched.current;
    if (last && last.tol === tol && last.nonce === citiesNonce && bboxContains(last.bbox, view.bounds)) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const bbox = padBBox(view.bounds);
      try {
        const rows = await fetchCitiesInView(bbox, view.zoom, mock);
        if (cancelled) return;
        citiesFetched.current = { bbox, tol, nonce: citiesNonce };
        setCities(rows);
      } catch (e) {
        console.warn("[cities]", (e as Error).message);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [view, mock, citiesNonce]);

  const currentCity = useMemo(
    () => (view && view.zoom >= 10 ? cityAt(cities, view.center.lat, view.center.lng) : null),
    [cities, view],
  );

  // Keep viewed ready cities fresh on the backend (once per city per session).
  useEffect(() => {
    if (!currentCity || currentCity.status !== "ready" || viewedCities.current.has(currentCity.id)) return;
    viewedCities.current.add(currentCity.id);
    markCityViewed(currentCity.id, mock).catch(() => {});
  }, [currentCity, mock]);

  // Poll the selected city while it's loading; when it turns ready, refetch happenings + outlines.
  const pollingId = selectedCity && (selectedCity.status === "queued" || selectedCity.status === "syncing") ? selectedCity.id : null;
  useEffect(() => {
    if (!pollingId) return;
    const t = setInterval(async () => {
      try {
        const st = await fetchCityStatus(pollingId, mock);
        if (!st) return;
        setSelectedCity((c) => (c && c.id === st.id ? mergeStatus(c, st) : c));
        setCities((rows) =>
          rows.map((r) =>
            r.id === st.id
              ? { ...r, status: st.status, phase: st.phase, venue_count: st.venue_count, happening_count: st.happening_count }
              : r,
          ),
        );
        if (st.status === "ready" || st.venue_count > 0) loadRef.current();
        if (st.status === "ready" || st.status === "error") setCitiesNonce((n) => n + 1);
      } catch {
        /* keep polling */
      }
    }, CITY_POLL_MS);
    return () => clearInterval(t);
  }, [pollingId, mock]);

  // City suggestions for the search bar.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale suggestions
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchCities(q, 5, mock)
        .then((r) => !cancelled && setSuggestions(r))
        .catch(() => !cancelled && setSuggestions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, mock]);

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
  const placeMatch = Boolean(hoodMatch) || suggestions.length > 0;
  const filtered = useMemo(() => {
    const base = current.filter((h) => (cats.length === 0 || cats.includes(h.category)) && (!liveOnly || h.is_live));
    const text = base.filter((h) => matchesQuery(h, query));
    // A neighborhood/city name with no text hits just moves the map (on submit) instead of emptying it.
    return text.length === 0 && placeMatch ? base : text;
  }, [current, cats, liveOnly, query, placeMatch]);

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
  const hasAny = liveTotal + upcomingTotal > 0;
  const sheetSubtitle =
    status === "offline" || status === "error"
      ? hasAny
        ? status === "offline"
          ? "Offline — showing last update"
          : "Couldn't refresh — showing last update"
        : status === "offline"
          ? "You're offline"
          : "Couldn't load right now"
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
      setSelectedCity(null);
      const g = groupsByKey.get(key);
      if (g) mapApi.current?.focus(g.lat, g.lng, Math.round(window.innerHeight * 0.55));
    },
    [groupsByKey],
  );

  const pick = useCallback((h: Happening) => select(groupKey(h)), [select]);

  // Open the city card (fresh status fetched in the background).
  const openCity = useCallback(
    (c: CityInfo | null) => {
      setRequestReason(null);
      setSelectedCity(c);
      if (!c) return;
      setSelectedKey(null);
      fetchCityStatus(c.id, mock)
        .then((st) => st && setSelectedCity((cur) => (cur && cur.id === st.id ? mergeStatus(cur, st) : cur)))
        .catch(() => {});
    },
    [mock],
  );

  const cityCenter = (c: { id: string; lat: number | null; lng: number | null }) =>
    c.id === NOLA_CITY_ID ? NOLA_CENTER : c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;

  const pickSuggestion = (r: CitySearchRow) => {
    setQuery("");
    setSuggestions([]);
    (document.activeElement as HTMLElement | null)?.blur();
    const c = cityCenter(r);
    if (c) mapApi.current?.flyTo(c.lat, c.lng, r.status === "ready" ? CITY_ZOOM : 11);
    openCity(rowToInfo(r));
  };

  const showCity = () => {
    if (!selectedCity) return;
    const c = cityCenter(selectedCity);
    if (c) mapApi.current?.flyTo(c.lat, c.lng, selectedCity.id === NOLA_CITY_ID ? DEFAULT_ZOOM : CITY_ZOOM);
    setSelectedCity(null);
  };

  const loadCity = async () => {
    const c = selectedCity;
    if (!c || requesting) return;
    setRequesting(true);
    setRequestReason(null);
    try {
      const res = await requestCity(c.id, mock);
      if (res.ok) {
        const status = res.status ?? "queued";
        setSelectedCity((cur) =>
          cur && cur.id === c.id ? { ...cur, status, phase: status === "queued" ? "osm" : cur.phase } : cur,
        );
        setCities((rows) => rows.map((r) => (r.id === c.id ? { ...r, status, phase: status === "queued" ? "osm" : r.phase } : r)));
      } else {
        setRequestReason(res.reason ?? "error");
      }
    } catch {
      setRequestReason("error");
    } finally {
      setRequesting(false);
    }
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hood = findNeighborhood(query);
    if (hood) mapApi.current?.flyTo(hood.lat, hood.lng, 15);
    else if (suggestions.length && filtered.every((h) => !matchesQuery(h, query))) return pickSuggestion(suggestions[0]);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const effectiveNoResults = query && filtered.length === 0 && !placeMatch;
  const showSuggestions = searchFocus && suggestions.length > 0;
  const hintCity =
    !selectedCity && !selected && view && view.zoom > CITY_PICK_MAX_ZOOM && currentCity && currentCity.allowed && currentCity.status !== "ready"
      ? currentCity
      : null;

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
        cities={cities}
        selectedCityId={selectedCity?.id ?? null}
        onCityPick={openCity}
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
            onFocus={() => setSearchFocus(true)}
            // Delay so a tap on a suggestion lands before the list unmounts.
            onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
            aria-label="Search venues, events, neighborhoods"
          />
          {query && (
            <button type="button" className="tm-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              ×
            </button>
          )}
        </form>
        {showSuggestions && (
          <div className="tm-suggest" role="listbox" aria-label="Cities">
            {suggestions.map((r) => (
              <button
                key={r.id}
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickSuggestion(r)}
                style={{
                  ["--c" as string]: !r.allowed ? "#6d5fb0" : r.status === "ready" ? "#67e8f9" : r.status === "none" ? "#a78bfa" : "#f0abfc",
                }}
              >
                <span className="tm-suggest-pin" />
                <span className="tm-suggest-name">{r.name}</span>
                <span className="tm-suggest-meta">
                  {!r.allowed ? "Outside area" : r.status === "ready" ? "Live" : r.status === "none" ? "Tap to load" : "Loading…"}
                </span>
              </button>
            ))}
          </div>
        )}

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

      {hintCity && (
        <button className="tm-city-hint" onClick={() => openCity(rowToInfo(hintCity))}>
          <span>
            {hintCity.status === "none" || hintCity.status === "error" ? (
              <>
                {hintCity.name} isn&apos;t on TapMap yet · <b>Load</b>
              </>
            ) : (
              <>
                Loading {hintCity.name}… <b>See progress</b>
              </>
            )}
          </span>
        </button>
      )}

      {selectedCity && !selected && (
        <CityCard
          key={selectedCity.id}
          city={selectedCity}
          requesting={requesting}
          requestReason={requestReason}
          onLoad={loadCity}
          onShow={showCity}
          onClose={() => setSelectedCity(null)}
        />
      )}

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
