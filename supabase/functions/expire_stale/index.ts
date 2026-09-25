// expire_stale (nightly): drop "live" eligibility of data nobody has re-verified.
//  - recurring happenings (starts_at null) with last_verified_at older than 14 days -> is_stale = true
//  - recurring happenings re-verified within 14 days that were stale             -> is_stale = false
//  - one-off happenings that ended more than 2 days ago                          -> is_stale = true
//  - raw_pages older than 30 days deleted (latest page per source kept)
// Params (optional): {"recurring_days":14,"oneoff_grace_days":2,"raw_days":30}
// All work is one SQL function (public.expire_stale_run) so it is atomic and fast.
import { serveJob } from "../_shared/job.ts";
import { db } from "../_shared/db.ts";

function num(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
}

serveJob("expire_stale", async (ctx) => {
  const { data, error } = await db().rpc("expire_stale_run", {
    p_recurring_days: num(ctx.params.recurring_days, 14, 1, 365),
    p_oneoff_grace_days: num(ctx.params.oneoff_grace_days, 2, 0, 60),
    p_raw_days: num(ctx.params.raw_days, 30, 1, 365),
  });
  if (error) throw new Error(`expire_stale_run: ${error.message}`);
  Object.assign(ctx.counts, data as Record<string, number>);
});
