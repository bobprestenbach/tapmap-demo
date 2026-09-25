"use client";

import { useState } from "react";
import { KIND_LABEL, metaFor } from "@/lib/categories";
import { reportWrongInfo } from "@/lib/data";
import { ago, formatMiles, timeLabel, windowLabel } from "@/lib/time";
import type { Happening, VenueGroup } from "@/lib/types";
import { CloseIcon } from "./icons";

function directionsUrl(h: Happening): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (typeof navigator !== "undefined" && /Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const name = encodeURIComponent(h.venue_name ?? h.title);
  if (isIOS) return `https://maps.apple.com/?daddr=${h.lat},${h.lng}&q=${name}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

const REASONS = ["Not happening", "Wrong time", "Wrong place", "Closed"];

function ReportBox({ id, mock }: { id: string; mock: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  if (state === "done") return <p className="tm-report-done">Thanks — we&apos;ll double-check this.</p>;
  if (!open)
    return (
      <button className="tm-link-btn" onClick={() => setOpen(true)}>
        Report wrong info
      </button>
    );
  const submit = async () => {
    setState("sending");
    try {
      if (!mock) await reportWrongInfo(id, reason.trim());
      setState("done");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="tm-report">
      <div className="tm-report-chips">
        {REASONS.map((r) => (
          <button key={r} className={`tm-mini-chip ${reason === r ? "on" : ""}`} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <input
        className="tm-report-input"
        placeholder="What's wrong? (optional)"
        maxLength={300}
        value={REASONS.includes(reason) ? "" : reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="tm-report-actions">
        <button className="tm-link-btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="tm-btn small" disabled={state === "sending"} onClick={submit}>
          {state === "sending" ? "Sending…" : "Send report"}
        </button>
      </div>
      {state === "error" && <p className="tm-error-text">Couldn&apos;t send — try again.</p>}
    </div>
  );
}

export default function DetailCard({
  group,
  distanceFor,
  now,
  mock,
  onClose,
}: {
  group: VenueGroup;
  distanceFor: (h: Happening) => number;
  now: Date;
  mock: boolean;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(group.primary.id);
  const h = group.items.find((x) => x.id === activeId) ?? group.primary;
  const meta = metaFor(h.category);
  const where = [h.neighborhood, h.address].filter(Boolean).join(" · ") || h.location_name;
  return (
    <div className="tm-detail" style={{ ["--c" as string]: meta.color }} role="dialog" aria-label={h.venue_name ?? h.title}>
      <div className="tm-detail-head">
        <div className="tm-detail-emoji">{meta.emoji}</div>
        <div className="tm-detail-titles">
          <h2>{h.venue_name ?? h.title}</h2>
          <div className="tm-detail-kind">
            {h.is_live ? <span className="tm-live-tag">● LIVE</span> : <span className="tm-soon-tag">UPCOMING</span>}
            <span>{KIND_LABEL[h.kind]}</span>
          </div>
        </div>
        <button className="tm-icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div className="tm-detail-body">
        <p className="tm-detail-title">{h.title}</p>
        <p className="tm-detail-time">
          {timeLabel(h, now)} <span className="tm-dim">· {windowLabel(h, now)}</span>
        </p>
        {h.description && h.description !== h.title && <p className="tm-detail-desc">{h.description}</p>}
        <div className="tm-detail-facts">
          {h.price_text && <span>💲 {h.price_text}</span>}
          <span>📍 {formatMiles(distanceFor(h))}</span>
        </div>
        {where && <p className="tm-detail-where">{where}</p>}

        <div className="tm-detail-actions">
          <a className="tm-btn" href={directionsUrl(h)} target="_blank" rel="noopener noreferrer">
            Directions
          </a>
          {h.website && (
            <a className="tm-btn ghost" href={h.website} target="_blank" rel="noopener noreferrer">
              Website
            </a>
          )}
        </div>

        {group.items.length > 1 && (
          <div className="tm-also">
            <h3>Also here</h3>
            {group.items.map((x) => (
              <button key={x.id} className={`tm-also-row ${x.id === h.id ? "on" : ""}`} onClick={() => setActiveId(x.id)}>
                <span className="tm-also-title">{x.title}</span>
                <span className={`tm-also-time ${x.is_live ? "live" : ""}`}>{timeLabel(x, now)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="tm-detail-foot">
          <span className="tm-dim">
            {h.source_url ? (
              <a href={h.source_url} target="_blank" rel="noopener noreferrer">
                {hostOf(h.source_url)}
              </a>
            ) : (
              "Public data"
            )}{" "}
            · verified {ago(h.last_verified_at, now)}
          </span>
          <ReportBox key={h.id} id={h.id} mock={mock} />
        </div>
      </div>
    </div>
  );
}
