// Polite fetching: identifying User-Agent, robots.txt, per-host rate limit, HTML -> text.
export const USER_AGENT =
  "TapMapBot/0.1 (+https://github.com/bobprestenbach/tapmap-demo; Louisiana happenings map)";

type RobotsRule = { allow: boolean; re: RegExp; len: number };
const robotsCache = new Map<string, RobotsRule[]>(); // origin -> rules applying to us
const lastHit = new Map<string, number>();

function ruleRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** RFC 9309 parsing: groups of consecutive User-agent lines; our group wins over '*'. */
export function parseRobots(txt: string): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let cur: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if ((k === "allow" || k === "disallow") && cur) {
      lastWasAgent = false;
      if (v) cur.rules.push({ allow: k === "allow", re: ruleRegex(v), len: v.length });
    } else {
      lastWasAgent = false;
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a.includes("tapmap")));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Longest matching rule wins; Allow wins ties; no match = allowed. */
export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function rulesFor(origin: string): Promise<RobotsRule[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: RobotsRule[] = [];
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) rules = parseRobots(await r.text());
  } catch { rules = []; }
  robotsCache.set(origin, rules);
  return rules;
}

export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  return isAllowed(await rulesFor(u.origin), u.pathname + u.search);
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
