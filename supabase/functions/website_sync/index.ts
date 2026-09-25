// website_sync: venue websites -> content hash -> (only if changed) LLM extraction -> happenings.
// Params: {"limit":N (default 30), "force":bool (ignore 20h skip + re-run LLM), "source_ids":[uuid],
//          "concurrency":N (default 5), "budget_ms":N (default 110000),
//          "min_llm_age_hours":N (default 72; changed pages re-extracted at most this often)}
import { serveJob, inc, JobCtx } from "../_shared/job.ts";
import { db } from "../_shared/db.ts";
import { processSite, Item } from "./pipeline.ts";

type SourceRow = {
  id: string;
  url: string;
  venue_id: string | null;
  content_hash: string | null;
  meta: Record<string, unknown> | null;
  venues: { name: string } | null;
};

const SKIP_HOURS = 20;
// Set when the AI Gateway is unavailable (402 out of credit, 429, 5xx): stop the batch and
// leave the affected source un-run so it is retried next time.
let llmDown = false;
const truthy = (v: unknown) => v === true || v === "true" || v === "1";

function toRow(it: Item, venueId: string, sourceId: string, now: string) {
  return {
    venue_id: venueId,
    kind: it.kind,
    title: it.title,
    description: it.description,
    price_text: it.price_text,
    starts_at: it.starts_at,
    ends_at: it.ends_at,
    days_of_week: it.days_of_week,
    start_time: it.start_time,
    end_time: it.end_time,
    source_id: sourceId,
    source_url: it.source_url,
    external_id: `web:${venueId}:${it.key}`,
    confidence: it.confidence,
    last_verified_at: now,
    is_stale: false,
  };
}

async function handle(ctx: JobCtx, s: SourceRow, force: boolean, minLlmAgeH: number) {
  const sb = db();
  const now = new Date().toISOString();
  const venueName = s.venues?.name ?? new URL(s.url.startsWith("http") ? s.url : `https://${s.url}`).host;
  const lastLlm = Date.parse(String(s.meta?.last_llm_at ?? "")) || 0;
  const skipLlm = !force && Date.now() - lastLlm < minLlmAgeH * 3600_000;
  const r = await processSite(s.url, { venueName, prevHash: force ? null : s.content_hash, forceLlm: force, skipLlm });
  if (r.status === "llm_error" && /AI gateway (402|429|5\d\d)/.test(r.error ?? "")) {
    llmDown = true;
    inc(ctx, "llm_unavailable");
    ctx.counts.llm_unavailable_error = (r.error ?? "").slice(0, 160);
    return;
  }
  inc(ctx, "sources");
  inc(ctx, "pages_fetched", r.pagesFetched);
  if (r.robotsBlocked) inc(ctx, "robots_blocked", r.robotsBlocked);
  if (r.llmCalled) inc(ctx, "llm_calls");
  if (r.usage) {
    inc(ctx, "llm_input_tokens", r.usage.input);
    inc(ctx, "llm_output_tokens", r.usage.output);
    ctx.counts.llm_cost_usd = Math.round((((ctx.counts.llm_cost_usd as number) ?? 0) + r.usage.cost) * 1e6) / 1e6;
  }
  inc(ctx, `status_${r.status}`);

  const prefix = s.venue_id ? `web:${s.venue_id}:` : null;
  let status = r.status;
  let newHash: string | null = s.content_hash;

  if ((r.status === "unchanged" || r.status === "changed_deferred") && prefix) {
    await sb.from("happenings").update({ last_verified_at: now })
      .like("external_id", `${prefix}%`).eq("is_stale", false);
  } else if (r.hash && r.status !== "llm_error") {
    // Page content changed (or first run): store raw text, replace extracted set.
    newHash = r.hash;
    await sb.from("raw_pages").insert({ source_id: s.id, url: r.pages[0]?.url ?? s.url, content_hash: r.hash, text: r.text });
    if (!s.venue_id) {
      status = "no_venue";
    } else {
      const byId = new Map(r.items.map((it) => { const row = toRow(it, s.venue_id!, s.id, now); return [row.external_id, row]; }));
      const rows = [...byId.values()];
      if (rows.length) {
        const { error } = await sb.from("happenings").upsert(rows, { onConflict: "external_id" });
        if (error) { inc(ctx, "errors"); status = `db_error: ${error.message.slice(0, 120)}`; newHash = s.content_hash; }
        else {
          inc(ctx, "happenings_upserted", rows.length);
          for (const row of rows) inc(ctx, `upserted_${row.kind}`);
        }
      }
      if (!status.startsWith("db_error")) {
        // Anything previously extracted from this site that is no longer present -> stale (keep row).
        const keep = new Set(rows.map((x) => x.external_id));
        const { data: prev } = await sb.from("happenings").select("id,external_id")
          .like("external_id", `${prefix}%`).eq("is_stale", false);
        const staleIds = (prev ?? []).filter((p) => !keep.has(p.external_id)).map((p) => p.id);
        if (staleIds.length) {
          await sb.from("happenings").update({ is_stale: true }).in("id", staleIds);
          inc(ctx, "marked_stale", staleIds.length);
        }
        if (status === "ok") status = `ok:${rows.length}`;
      }
    }
  }
  if (["llm_error", "fetch_error"].includes(r.status) || r.status.startsWith("http_")) inc(ctx, "errors");

  await sb.from("sources").update({
    last_run_at: now,
    last_status: (r.error && !status.includes(":") ? `${status}: ${r.error}` : status).slice(0, 300),
    content_hash: newHash,
    meta: {
      ...(s.meta ?? {}),
      pages: r.pages.map((p) => p.url),
      failed_pages: r.failedPages,
      items: r.items.length,
      dropped: r.dropped.length,
      last_llm_at: r.llmCalled ? now : (s.meta?.last_llm_at ?? null),
    },
  }).eq("id", s.id);
}

serveJob("website_sync", async (ctx) => {
  const t0 = Date.now();
  llmDown = false;
  const budget = Number(ctx.params.budget_ms ?? 110_000);
  const limit = Math.min(Number(ctx.params.limit ?? 30), 200);
  const concurrency = Math.max(1, Math.min(Number(ctx.params.concurrency ?? 5), 10));
  const force = truthy(ctx.params.force);
  // Cost control: a changed page is re-sent to the LLM at most once per this many hours.
  const minLlmAgeH = Number(ctx.params.min_llm_age_hours ?? 72);
  const ids = Array.isArray(ctx.params.source_ids) ? (ctx.params.source_ids as string[]) : null;

  let q = db().from("sources").select("id,url,venue_id,content_hash,meta,venues(name)").eq("kind", "website");
  if (ids) q = q.in("id", ids);
  else if (!force) {
    const cutoff = new Date(Date.now() - SKIP_HOURS * 3600_000).toISOString();
    q = q.or(`last_run_at.is.null,last_run_at.lt.${cutoff}`);
  }
  const { data, error } = await q.order("last_run_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) throw new Error(`sources query: ${error.message}`);
  const queue = [...((data ?? []) as unknown as SourceRow[])];
  ctx.counts.queued = queue.length;

  // Each site takes ~5-25s (polite per-host delays + one LLM call); stop picking new
  // sites when less than ~35s of budget remains.
  const worker = async () => {
    while (queue.length && !llmDown && Date.now() - t0 < budget - 35_000) {
      const s = queue.shift()!;
      try {
        await handle(ctx, s, force, minLlmAgeH);
      } catch (e) {
        inc(ctx, "errors");
        ctx.log("source failed", s.url, (e as Error).message);
        await db().from("sources").update({
          last_run_at: new Date().toISOString(),
          last_status: `error: ${(e as Error).message}`.slice(0, 300),
        }).eq("id", s.id);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  ctx.counts.remaining_in_batch = queue.length;
  ctx.counts.elapsed_ms = Date.now() - t0;
  // Surface gateway outages (e.g. out of credit) as a failed run in sync_runs.
  if (llmDown) throw new Error(`AI gateway unavailable: ${ctx.counts.llm_unavailable_error ?? ""}`);
});
