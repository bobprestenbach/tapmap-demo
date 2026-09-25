"use client";

import {
  OUTSIDE_MSG,
  PHASES,
  cityCardView,
  kindLabel,
  phaseIndex,
  phaseLabel,
  plural,
  requestReasonMessage,
  type CityInfo,
} from "@/lib/cities";
import { CloseIcon } from "./icons";

const ACCENT: Record<string, string> = {
  ready: "#67e8f9",
  progress: "#f0abfc",
  load: "#8b5cf6",
  error: "#fca5a5",
  outside: "#6d5fb0",
};

export default function CityCard({
  city,
  requesting,
  requestReason,
  onLoad,
  onShow,
  onClose,
}: {
  city: CityInfo;
  requesting: boolean;
  /** Reason from a refused request_city call (busy, budget, …). */
  requestReason: string | null;
  onLoad: () => void;
  onShow: () => void;
  onClose: () => void;
}) {
  const view = cityCardView(city);
  const step = phaseIndex(city.phase);
  const pct = city.status === "queued" ? 6 : Math.min(96, Math.round(((step + 0.5) / PHASES.length) * 100));
  return (
    <div className="tm-detail tm-city" style={{ ["--c" as string]: ACCENT[view] }} role="dialog" aria-label={city.name}>
      <div className="tm-detail-head">
        <div className="tm-city-badge" aria-hidden="true">
          {view === "ready" ? "●" : view === "progress" ? "⟳" : view === "outside" ? "–" : "+"}
        </div>
        <div className="tm-detail-titles">
          <h2>{city.name}</h2>
          <div className="tm-detail-kind">
            {view === "ready" && <span className="tm-live-tag">ON TAPMAP</span>}
            {view === "progress" && <span className="tm-city-tag">LOADING</span>}
            <span>{kindLabel(city.kind)} · Louisiana</span>
          </div>
        </div>
        <button className="tm-icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div className="tm-detail-body">
        {view === "ready" && (
          <>
            <p className="tm-city-stat">
              {city.venue_count > 0 ? (
                <>
                  <b>{plural(city.venue_count, "spot")}</b> · {plural(city.happening_count, "happening")}
                </>
              ) : (
                "Live on TapMap"
              )}
            </p>
            <div className="tm-detail-actions">
              <button className="tm-btn" onClick={onShow}>
                Show what&apos;s live
              </button>
            </div>
          </>
        )}

        {view === "load" && (
          <>
            <p className="tm-city-lead">Not on TapMap yet</p>
            <p className="tm-city-note">
              We&apos;ll pull bars, restaurants, happy hours and live music from public data. Takes about a minute.
            </p>
            {requestReason && <p className="tm-city-warn">{requestReasonMessage(requestReason)}</p>}
            <div className="tm-detail-actions">
              <button className="tm-btn" onClick={onLoad} disabled={requesting}>
                {requesting ? "Starting…" : `Load ${city.name}`}
              </button>
            </div>
          </>
        )}

        {view === "progress" && (
          <>
            <p className="tm-city-lead">{phaseLabel(city.status, city.phase)}…</p>
            <div className="tm-city-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <ol className="tm-city-steps">
              {PHASES.map((p, i) => (
                <li key={p.id} className={city.status !== "queued" && i < step ? "done" : i === step ? "on" : ""}>
                  {p.label}
                </li>
              ))}
            </ol>
            {city.venue_count > 0 && <p className="tm-city-stat">{plural(city.venue_count, "spot")} found so far</p>}
            <p className="tm-city-note">
              Venues show up in about a minute; happy hours fill in over the next few hours.
            </p>
          </>
        )}

        {view === "error" && (
          <>
            <p className="tm-city-lead">Couldn&apos;t load right now — we&apos;ll retry automatically</p>
            {requestReason && <p className="tm-city-warn">{requestReasonMessage(requestReason)}</p>}
            <div className="tm-detail-actions">
              <button className="tm-btn ghost" onClick={onLoad} disabled={requesting}>
                {requesting ? "Trying…" : "Try again"}
              </button>
            </div>
          </>
        )}

        {view === "outside" && <p className="tm-city-note">{OUTSIDE_MSG}</p>}
      </div>
    </div>
  );
}
