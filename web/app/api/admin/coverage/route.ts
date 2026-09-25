import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDb } from "@/lib/admin-db";

// Active work first, then problems, then ready, then untouched prewarm cities.
const STATUS_ORDER = ["syncing", "queued", "error", "ready", "none"];

/** Cities that are (or were) loaded or prewarmed, plus this month's spend. */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });

  const [cities, budget] = await Promise.all([
    db
      .from("cities")
      .select(
        "id, name, kind, status, phase, prewarm, attempts, venue_count, counts, last_viewed_at, requested_at, refreshed_at, last_error",
      )
      .or("status.neq.none,prewarm.eq.true")
      .order("area_km2", { ascending: false })
      .limit(500),
    db.rpc("budget_status"),
  ]);
  const err = cities.error || budget.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({
    cities: (cities.data ?? [])
      .map(({ counts, ...c }) => ({
        ...c,
        happening_count: Number((counts as Record<string, unknown> | null)?.happenings ?? 0),
      }))
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    budget: budget.data,
  });
}

/** Queue a city: {city_id} or {name} (first search_cities match). Goes through request_city (same rules as the app). */
export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  let id = typeof body?.city_id === "string" ? body.city_id.trim() : "";
  if (!id && typeof body?.name === "string" && body.name.trim().length >= 2) {
    const { data, error } = await db.rpc("search_cities", { q: body.name.trim(), p_limit: 1 });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    id = (data as { id: string }[] | null)?.[0]?.id ?? "";
    if (!id) return NextResponse.json({ error: `No city matches “${body.name}”` }, { status: 404 });
  }
  if (!/^\d{7}$/.test(id)) return NextResponse.json({ error: "city_id (7-digit Census GEOID) or name required" }, { status: 400 });
  const { data, error } = await db.rpc("request_city", { p_city_id: id });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ city_id: id, result: data });
}
