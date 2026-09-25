import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminDb } from "@/lib/admin-db";

const MAX_CAP_USD = 10_000;

/** Update app settings. Currently only {monthly_cap_usd: number}. */
export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const db = adminDb();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const cap = Number(body?.monthly_cap_usd);
  if (body?.monthly_cap_usd === undefined || body?.monthly_cap_usd === "" || !Number.isFinite(cap) || cap < 0 || cap > MAX_CAP_USD)
    return NextResponse.json({ error: `monthly_cap_usd must be a number between 0 and ${MAX_CAP_USD}` }, { status: 400 });
  const value = Math.round(cap * 100) / 100;
  const { error } = await db
    .from("app_settings")
    .upsert({ key: "monthly_cap_usd", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, monthly_cap_usd: value });
}
