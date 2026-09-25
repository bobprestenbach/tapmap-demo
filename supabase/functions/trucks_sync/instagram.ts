// Instagram Business Discovery adapter (DISABLED unless ENABLE_INSTAGRAM=true).
// Requires META_ACCESS_TOKEN (long-lived token for a Facebook user/system user that manages
// an Instagram Business/Creator account) and IG_BUSINESS_ACCOUNT_ID (that account's IG user id).
// Business Discovery lets that account read another *business/creator* account's public media:
//   GET https://graph.facebook.com/v21.0/{IG_BUSINESS_ACCOUNT_ID}
//       ?fields=business_discovery.username({handle}){username,name,media.limit(N){id,caption,timestamp,permalink}}
//       &access_token={META_ACCESS_TOKEN}
// Neither credential is available for the MVP, so this returns [] and trucks_sync creates no
// instagram sources. Captions returned here are fed through the same LLM stop extraction.
import { flag } from "../_shared/db.ts";

export type IgPost = { id: string; caption: string; timestamp: string; permalink: string };

const GRAPH = "https://graph.facebook.com/v21.0";

export function instagramEnabled(): boolean {
  return flag("ENABLE_INSTAGRAM") && !!Deno.env.get("META_ACCESS_TOKEN") &&
    !!Deno.env.get("IG_BUSINESS_ACCOUNT_ID");
}

export function businessDiscoveryUrl(handle: string, limit = 12): string {
  const id = Deno.env.get("IG_BUSINESS_ACCOUNT_ID") ?? "{IG_BUSINESS_ACCOUNT_ID}";
  const h = handle.replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
  const fields =
    `business_discovery.username(${h}){username,name,media.limit(${limit}){id,caption,timestamp,permalink}}`;
  return `${GRAPH}/${id}?fields=${encodeURIComponent(fields)}`;
}

/** Recent public posts of a business/creator IG account. [] when disabled or on error. */
export async function igRecentPosts(handle: string, limit = 12): Promise<IgPost[]> {
  if (!instagramEnabled()) return [];
  const url = businessDiscoveryUrl(handle, limit) +
    `&access_token=${encodeURIComponent(Deno.env.get("META_ACCESS_TOKEN")!)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      console.warn(`[instagram] ${handle}: HTTP ${r.status}`);
      return [];
    }
    const j = await r.json();
    const media = j?.business_discovery?.media?.data ?? [];
    return media
      .filter((m: IgPost) => m.caption)
      .map((m: IgPost) => ({ id: m.id, caption: m.caption, timestamp: m.timestamp, permalink: m.permalink }));
  } catch (e) {
    console.warn(`[instagram] ${handle}: ${e}`);
    return [];
  }
}

/** Render posts as text for the extraction prompt (newest first, with post dates). */
export function postsToText(handle: string, posts: IgPost[]): string {
  return posts
    .map((p) => `[@${handle} posted ${p.timestamp}] ${p.caption.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}
