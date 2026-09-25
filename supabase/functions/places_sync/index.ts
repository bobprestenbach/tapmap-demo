// places_sync: import NOLA venues (bars, restaurants, music venues) into public.venues.
//
// Discovery for all cities (incl. New Orleans) now runs through city_sync (OSM + cheap Google Place
// Details enrichment). This job remains for the New Orleans neighborhood import and curated lists.
//
// Providers (param "provider"; default "osm"):
//   osm      OpenStreetMap via Overpass. Upsert on osm_id, name+distance merge.
//   google   Google Places API (New) Text Search (Pro/Enterprise SKU, ~$35/1000 requests). No longer
//            scheduled; only runs when requested explicitly with {"provider":"google"} and
//            ENABLE_GOOGLE_PLACES=true. Per-hood 6-day cache (sources kind=google_places);
//            {"force":true} bypasses. Merges into OSM rows by name+<150 m.
//   curated  Upsert venues passed in the body as {"venues":[...]} (see data/venues/curated.json,
//            scripts/venues/sync_curated.sh). Matches existing rows by name + <150 m and enriches.
// Params: {"elements":[<pre-fetched Overpass elements>], "neighborhoods":["French Quarter",...], "includeNoWebsite":false, "dryRun":false, "maxPages":1}
// Also upserts a sources row (kind='website', cadence='daily') for every venue with a website.
import { db, flag } from "../_shared/db.ts";
import { recordUsage } from "../_shared/budget.ts";
import { inc, serveJob } from "../_shared/job.ts";
import { dedupeBatch, neighborhoodFor, normalizeInstagram, normalizeUrl, selectHoods, upsertVenues, VenueIn } from "./common.ts";
import { fetchGoogleVenues } from "./google.ts";
import { fetchOsmVenues, OsmEl } from "./osm.ts";

const BUDGET_MS = 110_000;

type CuratedIn = {
  name: string; category: VenueIn["category"]; lat: number; lng: number; address?: string; website?: string;
  instagram?: string; phone?: string; neighborhood?: string; osm_id?: string; opening_hours?: string;
};

serveJob("places_sync", async (ctx) => {
  const deadline = Date.now() + BUDGET_MS;
  const provider = String(ctx.params.provider ?? "osm");
  const hoods = selectHoods(ctx.params.neighborhoods);
  if (hoods.length === 0) throw new Error("no matching neighborhoods");
  ctx.counts.provider = provider;
  ctx.counts.neighborhoods = hoods.length;

  let venues: VenueIn[] = [];
  if (provider === "osm") {
    const { venues: v, stats } = await fetchOsmVenues(hoods, {
      includeNoWebsite: !!ctx.params.includeNoWebsite,
      elements: Array.isArray(ctx.params.elements) ? (ctx.params.elements as OsmEl[]) : undefined,
    }, ctx.log);
    Object.assign(ctx.counts, stats);
    venues = v;
  } else if (provider === "google") {
    if (!flag("ENABLE_GOOGLE_PLACES")) { ctx.counts.skipped = "ENABLE_GOOGLE_PLACES is off"; return; }
    // Hood-by-hood so progress survives the time budget; each hood is cached for 6 days
    // (sources kind='google_places') so repeated invocations never re-buy the same results.
    const force = !!ctx.params.force;
    const { data: recent } = await db().from("sources").select("url")
      .eq("kind", "google_places").gt("last_run_at", new Date(Date.now() - 6 * 864e5).toISOString());
    const fresh = new Set((recent ?? []).map((r) => r.url));
    for (const h of hoods) {
      const key = `gplaces:${h.name}`;
      if (!force && fresh.has(key)) { inc(ctx, "hoods_cached"); continue; }
      if (Date.now() > deadline - 25_000) { inc(ctx, "hoods_deferred"); continue; }
      const { venues: v, stats } = await fetchGoogleVenues([h], { maxPages: Number(ctx.params.maxPages ?? 2), deadline }, ctx.log);
      for (const [k, n] of Object.entries(stats)) inc(ctx, k, n);
      const d = dedupeBatch(v);
      inc(ctx, "candidates", d.length);
      inc(ctx, "with_website", d.filter((x) => x.website).length);
      await upsertVenues(ctx, d, deadline);
      if (!ctx.params.dryRun) {
        await db().from("sources").upsert({
          kind: "google_places", url: key, cadence: "weekly", last_run_at: new Date().toISOString(),
          last_status: "ok", meta: { requests: stats.requests, results: stats.raw },
        }, { onConflict: "kind,url" });
      }
      inc(ctx, "hoods_done");
    }
    ctx.counts.est_cost_usd = await recordUsage({
      service: "google", sku: "google_text_enterprise", units: Number(ctx.counts.requests ?? 0), job: "places_sync",
    });
    return;
  } else if (provider === "curated") {
    const list = (ctx.params.venues ?? []) as CuratedIn[];
    if (!Array.isArray(list) || list.length === 0) throw new Error('curated provider needs {"venues":[...]}');
    for (const c of list) {
      if (!c.name || typeof c.lat !== "number" || typeof c.lng !== "number") { inc(ctx, "curated_invalid"); continue; }
      venues.push({
        name: c.name, category: c.category, lat: c.lat, lng: c.lng, address: c.address ?? null,
        neighborhood: c.neighborhood ?? neighborhoodFor(c.lat, c.lng, undefined, 3) ?? null,
        website: normalizeUrl(c.website), instagram: normalizeInstagram(c.instagram), phone: c.phone ?? null,
        opening_hours: c.opening_hours ? { osm: c.opening_hours } : null,
        osm_id: c.osm_id ?? null, data_source: "curated", force_category: true, quality: 10,
      });
    }
  } else {
    throw new Error(`unknown provider ${provider}`);
  }

  const deduped = dedupeBatch(venues);
  ctx.counts.candidates = venues.length;
  ctx.counts.after_dedupe = deduped.length;
  ctx.counts.with_website = deduped.filter((v) => v.website).length;
  await upsertVenues(ctx, deduped, deadline);
});
