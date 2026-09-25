import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDb } from "@/lib/admin-db";

const KINDS = new Set(["happy_hour", "special", "live_music", "event", "truck_stop", "popup"]);

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });

  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim().replace(/[%,()*]/g, " ").slice(0, 80);
  const kind = sp.get("kind") ?? "";
  const hidden = sp.get("hidden") ?? "all"; // all | visible | hidden
  const reported = sp.get("reported") === "1";

  let query = db
    .from("happenings")
    .select(
      "id, venue_id, kind, title, description, price_text, starts_at, ends_at, days_of_week, start_time, end_time, location_name, source_url, confidence, last_verified_at, is_stale, is_hidden, updated_at, venue:venues!happenings_venue_id_fkey(id, name, category, neighborhood, is_hidden), reports(count)",
    )
    .order("updated_at", { ascending: false })
    .limit(300);

  if (KINDS.has(kind)) query = query.eq("kind", kind);
  if (hidden === "visible") query = query.eq("is_hidden", false);
  if (hidden === "hidden") query = query.eq("is_hidden", true);
  if (q) {
    const { data: vids } = await db.from("venues").select("id").ilike("name", `%${q}%`).limit(100);
    const ors = [`title.ilike.%${q}%`, `description.ilike.%${q}%`, `location_name.ilike.%${q}%`];
    if (vids?.length) ors.push(`venue_id.in.(${vids.map((v) => v.id).join(",")})`);
    query = query.or(ors.join(","));
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  type Row = { reports?: { count: number }[] } & Record<string, unknown>;
  let rows = (data as Row[]).map((r) => ({ ...r, report_count: r.reports?.[0]?.count ?? 0, reports: undefined }));
  if (reported) rows = rows.filter((r) => r.report_count > 0);
  return NextResponse.json({ happenings: rows });
}
