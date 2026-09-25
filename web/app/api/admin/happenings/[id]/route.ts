import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDb } from "@/lib/admin-db";

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error("expected string");
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  try {
    if ("title" in body) {
      const t = str(body.title, 200);
      if (!t) throw new Error("title is required");
      patch.title = t;
    }
    if ("description" in body) patch.description = str(body.description, 2000);
    if ("price_text" in body) patch.price_text = str(body.price_text, 200);
    if ("is_hidden" in body) patch.is_hidden = Boolean(body.is_hidden);
    for (const k of ["starts_at", "ends_at"] as const) {
      if (k in body) {
        const v = str(body[k], 40);
        if (v && Number.isNaN(Date.parse(v))) throw new Error(`${k} is not a valid timestamp`);
        patch[k] = v ? new Date(v).toISOString() : null;
      }
    }
    for (const k of ["start_time", "end_time"] as const) {
      if (k in body) {
        const v = str(body[k], 8);
        if (v && !TIME.test(v)) throw new Error(`${k} must be HH:MM`);
        patch[k] = v;
      }
    }
    if ("days_of_week" in body) {
      const d = body.days_of_week;
      if (d === null) patch.days_of_week = null;
      else if (Array.isArray(d) && d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6))
        patch.days_of_week = [...new Set(d as number[])].sort();
      else throw new Error("days_of_week must be integers 0-6");
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const { data, error } = await db.from("happenings").update(patch).eq("id", id).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
