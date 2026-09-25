"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { metaFor } from "@/lib/categories";
import { formatMiles, timeLabel } from "@/lib/time";
import type { Happening } from "@/lib/types";

export type SheetState = "peek" | "half" | "full";

export interface SheetSection {
  id: string;
  title: string;
  items: Happening[];
}

interface Props {
  state: SheetState;
  onState: (s: SheetState) => void;
  title: string;
  subtitle: string;
  liveCount: number;
  sections: SheetSection[];
  status: "loading" | "ok" | "error" | "offline";
  now: Date;
  distanceFor: (h: Happening) => number;
  onPick: (h: Happening) => void;
}

const PEEK = 92;

function heightFor(s: SheetState, vh: number): number {
  if (s === "peek") return PEEK;
  if (s === "half") return Math.round(vh * 0.46);
  return Math.round(vh - 150);
}

export default function BottomSheet(props: Props) {
  const { state, onState } = props;
  const [vh, setVh] = useState(844);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null);

  useEffect(() => {
    const upd = () => setVh(window.innerHeight);
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  const base = heightFor(state, vh);
  const height = drag ?? base;

  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, h: base, t: Date.now(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dy = s.y - e.clientY;
    if (Math.abs(dy) > 4) s.moved = true;
    if (s.moved) setDrag(Math.max(PEEK - 20, Math.min(vh - 110, s.h + dy)));
  };
  const onUp = useCallback(
    (e: React.PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      if (!s.moved) {
        setDrag(null);
        onState(state === "peek" ? "half" : "peek");
        return;
      }
      const dy = s.y - e.clientY;
      const velocity = dy / Math.max(1, Date.now() - s.t); // px/ms, + = up
      const h = s.h + dy;
      const snaps: [SheetState, number][] = [
        ["peek", heightFor("peek", vh)],
        ["half", heightFor("half", vh)],
        ["full", heightFor("full", vh)],
      ];
      let target: SheetState;
      if (Math.abs(velocity) > 0.6) {
        const idx = snaps.findIndex(([k]) => k === state);
        target = snaps[Math.max(0, Math.min(2, idx + (velocity > 0 ? 1 : -1)))][0];
      } else {
        target = snaps.reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
      }
      setDrag(null);
      onState(target);
    },
    [onState, state, vh],
  );

  const empty = props.sections.every((s) => s.items.length === 0);

  return (
    <section
      className={`tm-sheet ${drag != null ? "dragging" : ""}`}
      style={{ height: `calc(${height}px + env(safe-area-inset-bottom))` }}
      aria-label="Nearby list"
    >
      <div
        className="tm-sheet-grab"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        role="button"
        aria-expanded={state !== "peek"}
        aria-label="Expand list"
      >
        <div className="tm-sheet-handle" />
        <div className="tm-sheet-head">
          <div>
            <h2>{props.title}</h2>
            <p>{props.subtitle}</p>
          </div>
          <span className="tm-sheet-count">
            <span className="tm-dot" /> {props.liveCount}
          </span>
        </div>
      </div>
      <div className="tm-sheet-body">
        {props.status === "loading" && empty && <p className="tm-sheet-empty">Finding what&apos;s poppin&apos;…</p>}
        {props.status === "error" && empty && <p className="tm-sheet-empty">Couldn&apos;t load right now. Retrying…</p>}
        {props.status === "ok" && empty && (
          <p className="tm-sheet-empty">Nothing matches right now — try another filter or zoom out.</p>
        )}
        {props.sections.map(
          (sec) =>
            sec.items.length > 0 && (
              <div key={sec.id} className="tm-sec">
                <h3>{sec.title}</h3>
                <ul>
                  {sec.items.map((h) => {
                    const meta = metaFor(h.category);
                    return (
                      <li key={h.id}>
                        <button className="tm-row" onClick={() => props.onPick(h)} style={{ ["--c" as string]: meta.color }}>
                          <span className={`tm-row-emoji ${h.is_live ? "live" : ""}`}>{meta.emoji}</span>
                          <span className="tm-row-main">
                            <span className="tm-row-venue">{h.venue_name ?? h.location_name ?? h.title}</span>
                            <span className="tm-row-title">{h.title}</span>
                            <span className={`tm-row-time ${h.is_live ? "live" : ""}`}>{timeLabel(h, props.now)}</span>
                          </span>
                          <span className="tm-row-dist">{formatMiles(props.distanceFor(h))}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ),
        )}
      </div>
    </section>
  );
}
