import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDb } from "@/lib/admin-db";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });

  const [runs, reports, venues, happenings] = await Promise.all([
    db.from("sync_runs").select("id, job, started_at, finished_at, ok, counts, error").order("started_at", { ascending: false }).limit(40),
    db
      .from("reports")
      .select("id, reason, created_at, resolved, happening_id, venue_id, happening:happenings(id, title, kind), venue:venues(id, name)")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(100),
    db.from("venues").select("id", { count: "exact", head: true }),
    db.from("happenings").select("id", { count: "exact", head: true }),
  ]);
  const err = runs.error || reports.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({
    syncRuns: runs.data,
    reports: reports.data,
    counts: { venues: venues.count ?? 0, happenings: happenings.count ?? 0 },
  });
}
