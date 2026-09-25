import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const ADMIN_COOKIE = "tapmap_admin";
const MAX_AGE_S = 7 * 24 * 3600;

function secret(): string | null {
  const p = process.env.ADMIN_PASSWORD;
  return p && p.length > 0 ? p : null;
}

function sha(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time password comparison (hash both sides so lengths match). */
export function passwordMatches(input: string): boolean {
  const s = secret();
  if (!s) return false;
  return timingSafeEqual(sha(input), sha(s));
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function makeToken(now = Date.now()): string {
  const s = secret();
  if (!s) throw new Error("ADMIN_PASSWORD not set");
  const exp = Math.floor(now / 1000) + MAX_AGE_S;
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload, s)}`;
}

export function verifyToken(token: string | undefined, now = Date.now()): boolean {
  const s = secret();
  if (!s || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "admin") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, s));
  const got = Buffer.from(parts[2]);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifyToken(jar.get(ADMIN_COOKIE)?.value);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: MAX_AGE_S,
  };
}

/** Returns a 401 response when the request is not from a logged-in admin, else null. */
export async function requireAdmin(): Promise<NextResponse | null> {
  if (!secret()) return NextResponse.json({ error: "ADMIN_PASSWORD is not configured" }, { status: 503 });
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
