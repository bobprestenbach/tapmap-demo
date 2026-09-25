import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";

export async function GET() {
  return NextResponse.json({
    authed: await isAdmin(),
    dbConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
}
