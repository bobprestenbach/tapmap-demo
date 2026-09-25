// Eval for website extraction: runs the website_sync pipeline (fetch + subpage discovery +
// LLM extraction + validation) against ~15 real New Orleans bars, WITHOUT writing to the DB,
// and dumps per-venue results as JSON + a Markdown skeleton for manual spot-checks.
//
// Usage (needs AI_GATEWAY_API_KEY; SUPABASE_ACCESS_TOKEN to pick venues from the DB):
//   DENO_CERT=/root/.ccr/ca-bundle.crt npx -y deno run -A scripts/eval/website_eval.ts \
//     [--from-db] [--n 15] [--out <dir>]
// --from-db picks bars with websites from the venues table (via the Management API SQL endpoint);
// otherwise a built-in list of well-known NOLA bars is used.
import { processSite, SiteResult } from "../../supabase/functions/website_sync/pipeline.ts";

const args = Deno.args;
const argVal = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(argVal("--n", "15"));
const OUT = argVal("--out", "docs/eval");
const REF = "jombmjxzvpskjjxahmul";

const FALLBACK: { name: string; website: string }[] = [
  { name: "Cure", website: "https://www.curenola.com" },
  { name: "Bacchanal Wine", website: "https://www.bacchanalwine.com" },
  { name: "The Spotted Cat Music Club", website: "https://www.spottedcatmusicclub.com" },
  { name: "d.b.a.", website: "https://www.dbaneworleans.com" },
  { name: "Cane & Table", website: "https://www.caneandtablenola.com" },
  { name: "Twelve Mile Limit", website: "https://www.twelvemilelimit.com" },
  { name: "Barrel Proof", website: "https://www.barrelproofnola.com" },
  { name: "Bar Tonique", website: "https://www.bartonique.com" },
  { name: "Erin Rose", website: "https://www.erinrosebar.com" },
  { name: "Maple Leaf Bar", website: "https://www.mapleleafbar.com" },
  { name: "Mimi's in the Marigny", website: "https://www.mimisinthemarigny.com" },
  { name: "Sidecar Patio & Oyster Bar", website: "https://www.sidecarnola.com" },
  { name: "Bayou Beer Garden", website: "https://www.bayoubeergarden.com" },
  { name: "Pal's Lounge", website: "https://www.palslounge.com" },
  { name: "The Avenue Pub", website: "https://www.theavenuepub.com" },
];

async function venuesFromDb(n: number) {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN not set");
  const sql = `select v.id, v.name, v.website, v.neighborhood from venues v
    where v.category in ('bar','music_venue') and v.website is not null and not v.is_hidden
      and v.website !~* '(facebook|instagram|yelp|linktr|toasttab|google)\\.'
    order by md5(v.id::text) limit ${n}`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`db query ${r.status}: ${await r.text()}`);
  return (await r.json()) as { id: string; name: string; website: string; neighborhood: string | null }[];
}

const venues = args.includes("--from-db") ? await venuesFromDb(N) : FALLBACK.slice(0, N);
console.error(`Evaluating ${venues.length} venues`);

const results: (SiteResult & { name: string; website: string; ms: number })[] = [];
// Run 4 at a time (different hosts, so per-host politeness is preserved).
const queue = [...venues];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const v = queue.shift()!;
    const t = Date.now();
    const r = await processSite(v.website, { venueName: v.name, forceLlm: true });
    results.push({ ...r, name: v.name, website: v.website, ms: Date.now() - t });
    console.error(`${v.name}: ${r.status} pages=${r.pages.length} items=${r.items.length} dropped=${r.dropped.length}`);
  }
}));
results.sort((a, b) => a.name.localeCompare(b.name));

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/website_extraction_results.json`, JSON.stringify(results, null, 1));

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const sched = (i: SiteResult["items"][number]) => i.date
  ? `${i.date} ${new Date(i.starts_at!).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })}`
  : `${(i.days_of_week ?? []).map((d) => DAYS[d]).join(",")} ${i.start_time}-${i.end_time ?? "?"}`;

const tot = { items: 0, hh: 0, special: 0, music: 0, event: 0, llm: 0, inTok: 0, outTok: 0, cost: 0, pages: 0, exact: 0, fuzzy: 0, missing: 0, jsonld: 0 };
for (const r of results) {
  tot.items += r.items.length; tot.pages += r.pagesFetched;
  if (r.llmCalled) tot.llm++;
  if (r.usage) { tot.inTok += r.usage.input; tot.outTok += r.usage.output; tot.cost += r.usage.cost; }
  for (const i of r.items) {
    if (i.kind === "happy_hour") tot.hh++; else if (i.kind === "special") tot.special++;
    else if (i.kind === "live_music") tot.music++; else tot.event++;
    tot[i.evidence_found]++;
  }
}

let md = `## Automated run (${new Date().toISOString().slice(0, 16)}Z)\n\n`;
md += `| Metric | Value |\n|---|---|\n`;
md += `| Venues | ${results.length} |\n| Venues with >=1 item | ${results.filter((r) => r.items.length).length} |\n`;
md += `| Items (happy hour / special / live music / event+popup) | ${tot.items} (${tot.hh} / ${tot.special} / ${tot.music} / ${tot.event}) |\n`;
md += `| Evidence quote found exact / fuzzy / missing / JSON-LD | ${tot.exact} / ${tot.fuzzy} / ${tot.missing} / ${tot.jsonld} |\n`;
md += `| Pages fetched | ${tot.pages} |\n| LLM calls | ${tot.llm} |\n`;
md += `| Tokens in / out | ${tot.inTok} / ${tot.outTok} |\n| Cost (gateway-reported) | $${tot.cost.toFixed(4)} |\n\n`;
md += `### Per venue\n\n`;
for (const r of results) {
  md += `#### ${r.name} — ${r.website}\n\nStatus: \`${r.status}\`${r.error ? ` (${r.error})` : ""}; pages: ${r.pages.map((p) => `${p.url}${p.guessed ? " (guessed)" : ""} [${p.chars}c]`).join(", ") || "none"}; ${(r.ms / 1000).toFixed(1)}s\n\n`;
  if (r.items.length) {
    md += `| Kind | Title | Schedule | Price | Conf | Evidence |\n|---|---|---|---|---|---|\n`;
    for (const i of r.items) {
      md += `| ${i.kind} | ${i.title.replace(/\|/g, "/")} | ${sched(i)} | ${(i.price_text ?? "").replace(/\|/g, "/").slice(0, 60)} | ${i.confidence} | ${i.evidence_found}: "${(i.evidence ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 90)}" |\n`;
    }
    md += `\n`;
  } else md += `No items extracted.\n\n`;
  if (r.dropped.length) md += `Dropped by validation: ${r.dropped.map((d) => d.reason).join(", ")}\n\n`;
}
await Deno.writeTextFile(`${OUT}/website_extraction_auto.md`, md);
console.log(md);
