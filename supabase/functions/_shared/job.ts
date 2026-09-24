// Job wrapper: cron-secret auth + sync_runs bookkeeping + JSON response.
import { db } from "./db.ts";

export type Counts = Record<string, number | string>;
export type JobCtx = { counts: Counts; params: Record<string, unknown>; log: (...a: unknown[]) => void };

function authorized(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return false;
  if (req.headers.get("x-cron-secret") === secret) return true;
  const auth = req.headers.get("authorization") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!service && auth === `Bearer ${service}`;
}

/** Wraps a sync job. Functions are deployed with verify_jwt=false and authenticate via x-cron-secret. */
export function serveJob(job: string, run: (ctx: JobCtx) => Promise<void>) {
  Deno.serve(async (req) => {
    if (!authorized(req)) return new Response("unauthorized", { status: 401 });
    let params: Record<string, unknown> = {};
    try { params = req.method === "POST" ? await req.json() : {}; } catch { /* no body */ }
    const url = new URL(req.url);
    url.searchParams.forEach((v, k) => (params[k] = v));

    const { data: runRow } = await db().from("sync_runs").insert({ job }).select("id").single();
    const ctx: JobCtx = { counts: {}, params, log: (...a) => console.log(`[${job}]`, ...a) };
    let ok = true, error: string | null = null;
    try {
      await run(ctx);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? `${e.message}\n${e.stack ?? ""}`.slice(0, 4000) : String(e);
      console.error(`[${job}] failed`, e);
    }
    if (runRow) {
      await db().from("sync_runs")
        .update({ finished_at: new Date().toISOString(), ok, counts: ctx.counts, error })
        .eq("id", runRow.id);
    }
    return Response.json({ job, ok, counts: ctx.counts, error }, { status: ok ? 200 : 500 });
  });
}

export function inc(ctx: JobCtx, key: string, by = 1) {
  ctx.counts[key] = ((ctx.counts[key] as number) ?? 0) + by;
}
