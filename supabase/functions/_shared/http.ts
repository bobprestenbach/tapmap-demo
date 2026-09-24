// Polite fetching: identifying User-Agent, robots.txt, per-host rate limit, HTML -> text.
export const USER_AGENT =
  "TapMapBot/0.1 (+https://github.com/bobprestenbach/tapmap-demo; New Orleans happenings map)";

const robotsCache = new Map<string, string[] | null>(); // host -> disallow prefixes for *
const lastHit = new Map<string, number>();

async function disallowsFor(origin: string): Promise<string[]> {
  if (robotsCache.has(origin)) return robotsCache.get(origin) ?? [];
  let rules: string[] = [];
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      let applies = false;
      for (const raw of (await r.text()).split("\n")) {
        const line = raw.split("#")[0].trim();
        const [k, ...rest] = line.split(":");
        const v = rest.join(":").trim();
        if (/^user-agent$/i.test(k)) applies = v === "*" || /tapmap/i.test(v);
        else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
      }
    }
  } catch { rules = []; }
  robotsCache.set(origin, rules);
  return rules;
}

export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  const rules = await disallowsFor(u.origin);
  const path = u.pathname + u.search;
  return !rules.some((p) => {
    const prefix = p.replace(/\*.*$/, "").replace(/\$$/, "");
    return prefix !== "" && path.startsWith(prefix);
  });
}

/** Fetch respecting robots.txt and a minimum delay per host. Returns null if disallowed. */
export async function politeFetch(
  url: string,
  init: RequestInit & { minDelayMs?: number; timeoutMs?: number } = {},
): Promise<Response | null> {
  if (!(await robotsAllowed(url))) return null;
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + (init.minDelayMs ?? 1500) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  return await fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*", ...(init.headers ?? {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(init.timeoutMs ?? 15000),
  });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "-")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
