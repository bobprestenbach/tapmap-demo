"use client";

import { useCallback, useEffect, useState } from "react";
import { KIND_LABEL } from "@/lib/categories";
import { ago } from "@/lib/time";
import type { Kind } from "@/lib/types";

interface AdminHappening {
  id: string;
  venue_id: string | null;
  kind: Kind;
  title: string;
  description: string | null;
  price_text: string | null;
  starts_at: string | null;
  ends_at: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  location_name: string | null;
  source_url: string | null;
  confidence: number;
  last_verified_at: string;
  is_stale: boolean;
  is_hidden: boolean;
  updated_at: string;
  venue: { id: string; name: string; category: string; neighborhood: string | null; is_hidden: boolean } | null;
  report_count: number;
}

interface SyncRun {
  id: number;
  job: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  counts: Record<string, unknown>;
  error: string | null;
}

interface Report {
  id: number;
  reason: string | null;
  created_at: string;
  happening: { id: string; title: string; kind: string } | null;
  venue: { id: string; name: string } | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  // datetime-local in America/Chicago
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return f.replace(" ", "T");
}

/** Interpret a datetime-local string as America/Chicago wall clock → ISO. */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const guess = new Date(`${v}:00Z`);
  const asChicago = new Date(guess.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = asUtc.getTime() - asChicago.getTime();
  return new Date(guess.getTime() + offset).toISOString();
}

function schedule(h: AdminHappening): string {
  if (h.starts_at) {
    const f = (s: string) =>
      new Date(s).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `${f(h.starts_at)}${h.ends_at ? ` → ${f(h.ends_at)}` : ""}`;
  }
  const days = (h.days_of_week ?? []).map((d) => DAYS[d]).join(" ");
  return `${days} ${h.start_time?.slice(0, 5) ?? ""}–${h.end_time?.slice(0, 5) ?? "?"}`;
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ad-login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pw }) });
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="ad-brand">TapMap Admin</h1>
      <input type="password" autoFocus placeholder="Admin password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="ad-btn primary" disabled={busy || !pw}>
        {busy ? "Checking…" : "Log in"}
      </button>
      {err && <p className="ad-err">{err}</p>}
    </form>
  );
}

function EditForm({ h, onSaved, onCancel }: { h: AdminHappening; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(h.title);
  const [description, setDescription] = useState(h.description ?? "");
  const [price, setPrice] = useState(h.price_text ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInput(h.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(h.ends_at));
  const [days, setDays] = useState<number[]>(h.days_of_week ?? []);
  const [startTime, setStartTime] = useState(h.start_time?.slice(0, 5) ?? "");
  const [endTime, setEndTime] = useState(h.end_time?.slice(0, 5) ?? "");
  const [err, setErr] = useState("");
  const recurring = !h.starts_at;

  const save = async () => {
    setErr("");
    const body: Record<string, unknown> = { title, description, price_text: price };
    if (recurring) {
      Object.assign(body, { days_of_week: days, start_time: startTime || null, end_time: endTime || null });
    } else {
      Object.assign(body, { starts_at: fromLocalInput(startsAt), ends_at: fromLocalInput(endsAt) });
    }
    try {
      await api(`/api/admin/happenings/${h.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="ad-edit">
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Description
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Price text
        <input value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      {recurring ? (
        <>
          <div className="ad-days">
            {DAYS.map((d, i) => (
              <button
                type="button"
                key={d}
                className={`ad-day ${days.includes(i) ? "on" : ""}`}
                onClick={() => setDays((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()))}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="ad-row2">
            <label>
              Start (CT)
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label>
              End (CT)
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>
        </>
      ) : (
        <div className="ad-row2">
          <label>
            Starts (CT)
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label>
            Ends (CT)
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
        </div>
      )}
      {err && <p className="ad-err">{err}</p>}
      <div className="ad-actions">
        <button className="ad-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="ad-btn primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

function HappeningsTab() {
  const [rows, setRows] = useState<AdminHappening[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [hidden, setHidden] = useState("all");
  const [reported, setReported] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const p = new URLSearchParams({ q, kind, hidden, reported: reported ? "1" : "" });
      const r = await api<{ happenings: AdminHappening[] }>(`/api/admin/happenings?${p}`);
      setRows(r.happenings);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, kind, hidden, reported]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const patchHappening = async (id: string, body: object) => {
    try {
      await api(`/api/admin/happenings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const patchVenue = async (id: string, is_hidden: boolean) => {
    try {
      await api(`/api/admin/venues/${id}`, { method: "PATCH", body: JSON.stringify({ is_hidden }) });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="ad-filters">
        <input placeholder="Search title / venue…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={hidden} onChange={(e) => setHidden(e.target.value)}>
          <option value="all">Visible + hidden</option>
          <option value="visible">Visible only</option>
          <option value="hidden">Hidden only</option>
        </select>
        <label className="ad-check">
          <input type="checkbox" checked={reported} onChange={(e) => setReported(e.target.checked)} /> Reported
        </label>
      </div>
      {err && <p className="ad-err">{err}</p>}
      <p className="ad-muted">{loading ? "Loading…" : `${rows.length} happenings (most recently updated first)`}</p>
      <ul className="ad-list">
        {rows.map((h) => (
          <li key={h.id} className={`ad-item ${h.is_hidden ? "hidden" : ""}`}>
            <div className="ad-item-top">
              <div className="ad-item-main">
                <div className="ad-item-title">
                  <span className="ad-kind">{KIND_LABEL[h.kind] ?? h.kind}</span>
                  {h.title}
                </div>
                <div className="ad-item-sub">
                  {h.venue?.name ?? h.location_name ?? "—"}
                  {h.venue?.is_hidden && <span className="ad-tag warn">venue hidden</span>}
                  {h.is_hidden && <span className="ad-tag warn">hidden</span>}
                  {h.is_stale && <span className="ad-tag">stale</span>}
                  {h.report_count > 0 && <span className="ad-tag bad">{h.report_count} report(s)</span>}
                </div>
                <div className="ad-item-meta">
                  {schedule(h)} · {h.price_text ?? "no price"} · conf {h.confidence.toFixed(2)} · verified {ago(h.last_verified_at)}
                  {h.source_url && (
                    <>
                      {" · "}
                      <a href={h.source_url} target="_blank" rel="noopener noreferrer">
                        source
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="ad-item-actions">
                <button className="ad-btn" onClick={() => setEditing(editing === h.id ? null : h.id)}>
                  Edit
                </button>
                <button className="ad-btn" onClick={() => patchHappening(h.id, { is_hidden: !h.is_hidden })}>
                  {h.is_hidden ? "Unhide" : "Hide"}
                </button>
                {h.venue && (
                  <button className="ad-btn" onClick={() => patchVenue(h.venue!.id, !h.venue!.is_hidden)}>
                    {h.venue.is_hidden ? "Unhide venue" : "Hide venue"}
                  </button>
                )}
              </div>
            </div>
            {editing === h.id && (
              <EditForm
                h={h}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  load();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function OverviewTab() {
  const [data, setData] = useState<{ syncRuns: SyncRun[]; reports: Report[]; counts: { venues: number; happenings: number } } | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api("/api/admin/overview"));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    load();
  }, [load]);
  const resolve = async (id: number) => {
    await api(`/api/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) }).catch((e) => setErr(e.message));
    load();
  };
  if (err) return <p className="ad-err">{err}</p>;
  if (!data) return <p className="ad-muted">Loading…</p>;
  return (
    <>
      <p className="ad-muted">
        {data.counts.venues} venues · {data.counts.happenings} happenings
      </p>
      <h2 className="ad-h2">Open reports ({data.reports.length})</h2>
      {data.reports.length === 0 && <p className="ad-muted">No open reports.</p>}
      <ul className="ad-list">
        {data.reports.map((r) => (
          <li key={r.id} className="ad-item">
            <div className="ad-item-top">
              <div className="ad-item-main">
                <div className="ad-item-title">{r.happening?.title ?? "(deleted happening)"}</div>
                <div className="ad-item-sub">
                  {r.venue?.name ?? "—"} · “{r.reason ?? "no reason"}” · {ago(r.created_at)}
                </div>
              </div>
              <div className="ad-item-actions">
                <button className="ad-btn" onClick={() => resolve(r.id)}>
                  Resolve
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <h2 className="ad-h2">Recent sync runs</h2>
      <div className="ad-table-wrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Counts / error</th>
            </tr>
          </thead>
          <tbody>
            {data.syncRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.job}</td>
                <td>{ago(r.started_at)}</td>
                <td>{r.finished_at ? `${Math.round((+new Date(r.finished_at) - +new Date(r.started_at)) / 1000)}s` : "running"}</td>
                <td className={r.ok ? "ok" : r.ok === false ? "bad" : ""}>{r.ok ? "ok" : r.ok === false ? "failed" : "…"}</td>
                <td className="ad-mono">{r.error ?? JSON.stringify(r.counts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function AdminApp() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [dbConfigured, setDbConfigured] = useState(true);
  const [tab, setTab] = useState<"happenings" | "overview">("happenings");

  const check = useCallback(async () => {
    const s = await api<{ authed: boolean; dbConfigured: boolean }>("/api/admin/session").catch(() => ({ authed: false, dbConfigured: true }));
    setAuthed(s.authed);
    setDbConfigured(s.dbConfigured);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session check
    check();
  }, [check]);

  if (authed === null) return <div className="ad-root" />;
  if (!authed)
    return (
      <div className="ad-root">
        <Login onDone={check} />
      </div>
    );
  return (
    <div className="ad-root">
      <header className="ad-header">
        <h1 className="ad-brand">TapMap Admin</h1>
        <nav className="ad-tabs">
          <button className={tab === "happenings" ? "on" : ""} onClick={() => setTab("happenings")}>
            Happenings
          </button>
          <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>
            Reports &amp; sync
          </button>
        </nav>
        <button
          className="ad-btn"
          onClick={async () => {
            await api("/api/admin/logout", { method: "POST" });
            setAuthed(false);
          }}
        >
          Log out
        </button>
      </header>
      {!dbConfigured && <p className="ad-err">SUPABASE_SERVICE_ROLE_KEY is not set on the server — admin data is unavailable.</p>}
      <main className="ad-main">{tab === "happenings" ? <HappeningsTab /> : <OverviewTab />}</main>
    </div>
  );
}
