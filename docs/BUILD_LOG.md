# TapMap MVP: Build Log

Build session: 2026-09-24 to 25 (America/Chicago). The lead agent built the schema, shared code and integration.
Five parallel sub-agents built venues, website extraction, events, trucks and the frontend.

## Status against the definition of done

| Item | Status |
|---|---|
| Production URL, installable PWA, looks like the reference | ✅ https://tapmap-two.vercel.app (manifest, icons, iOS meta, service worker offline shell). Compare `docs/design/screenshot-prod-390.png` with `reference.webp` |
| ≥150 real venues | ✅ 889 visible venues (Google Places + OSM + curated + Ticketmaster/WWOZ venues) |
| ≥50 happy hours/specials | ✅ 168 active (103 happy hours, 67 specials from 161 venues at extraction time) |
| ≥30 upcoming events | ✅ 563 in the next 14 days (Ticketmaster + WWOZ + venue websites) |
| Some food truck stops | ✅ 13 upcoming (4 truck stops, 9 pop-ups). Thin; see gaps |
| "N live now" correct for Central time | ✅ RPC regression test passes 8/8 (weekday windows, overnight, DST/CST, filters). Spot checks: Fri 12:30 → 28 live, Fri 17:30 → 97, Fri 21:30 → 89, Sat 02:00 → 4, Sat 06:00 → 2 |
| All sync jobs scheduled in pg_cron and succeeded once | ✅ 7 cron jobs. `sync_runs` shows ok runs for places_sync, website_sync, events_sync, trucks_sync and expire_stale |
| Admin can hide/edit a happening | ✅ Verified in production: bad password → 401, login → 200, hide → the item disappears from the public API, unhide → it returns, no cookie → 401 |
| Lint/typecheck/tests pass; no secrets in git | ✅ `web`: eslint, tsc and vitest (22 tests) pass. `deno check` passes for the functions. The diff was scanned for key patterns before every commit |
| README + BUILD_LOG | ✅ |

## What was built

- **DB** (`supabase/migrations/`):
  - PostGIS, pg_trgm, pg_cron and pg_net.
  - Tables: `venues`, `happenings`, `sources`, `raw_pages`, `sync_runs`, `reports`, plus agent helper tables (`event_venue_cache`, `truck_geocode_cache`).
  - RLS: public read of non-hidden rows only.
  - RPCs: `happenings_near` (recurrence expansion with America/Chicago handling) and `report_wrong_info`.
  - `private.invoke_job()`, which calls the edge functions from pg_cron using Vault secrets.
- **Edge functions:** `places_sync`, `website_sync`, `events_sync`, `trucks_sync`, `expire_stale`. They share:
  - `serveJob` (x-cron-secret auth + `sync_runs` bookkeeping)
  - `politeFetch` (RFC 9309 robots.txt, TapMapBot UA, per-host delay)
  - `extractJson` (AI Gateway → `anthropic/claude-haiku-4.5`)
- **Frontend** (`web/`), Next.js 16:
  - MapLibre GL with MapTiler `openstreetmap-dark`, re-tinted to match the reference.
  - Neon double-ring category markers with clustering; live items pulse.
  - Live counter for the current view, search, filter chips, bottom sheet ("Your city live").
  - Detail card with directions, website, source, "verified X ago" and "Report wrong info".
  - Realtime refresh, PWA and the `/admin` page.
- **Eval:** `docs/eval/website_extraction.md`. 30 bars; 65/67 extracted items correct, no invented times.

## Deviations from the plan, and why

- **Google Places was blocked at the start** (billing disabled, 403). OSM was used first. After the owner fixed billing,
  Google became the primary provider, merged with the OSM rows.
- **Venue count:** 889, far above the ~150 target, because Google and OSM together cover many restaurants.
  `website_sync` processes them in hourly batches of 40 (about 960 slots a day for about 656 website sources).
- **Map style:** MapTiler `openstreetmap-dark` plus runtime re-tinting matched the reference better than `dataviz-dark` or
  `streets-v2-dark`.
- **Robots.txt:** the first shared parser was too strict, because Squarespace/WooCommerce wildcard rules blocked whole sites.
  It was replaced with a correct RFC 9309 implementation.

## Skipped and why

- **SeatGeek:** no `SEATGEEK_CLIENT_ID`. The adapter is built behind `ENABLE_SEATGEEK=false`.
- **Instagram Business Discovery:** no Meta credentials. The adapter is built behind `ENABLE_INSTAGRAM=false`.
  This matters most for food trucks, which mostly post on Instagram.
- **OffBeat:** crawling is allowed, but the events widget returns no rows and there is no API.
- **NOLA.com / Gambit:** the calendar is rendered client-side by a third-party script.
- **Roaming Hunger:** its robots.txt signals `ai-train=no`, so it was not scraped.
- **StreetFoodFinder (Cloudflare challenge), bestfoodtrucks (Vercel checkpoint), Miel's own site (403):** blocked.
  Miel is covered through its Mato calendar instead.
- **WWOZ:** robots.txt disallows named AI crawlers. TapMapBot falls under `User-agent: *`, which allows the calendar,
  and WWOZ pages are parsed deterministically; no LLM reads them. The 10s crawl delay is honored.

## Known gaps

- **AI Gateway credit ran out** (HTTP 402) partway through the first website run. 91 website sources are still
  queued (`last_status = 'pending_retry: ai gateway 402'`); the hourly cron will drain them once credit is added.
  The truck calendars for Miel and Parleaux are waiting for the same reason. Every job treats 402/429/5xx as
  "leave queued", not as "done".
- **Pages we can't read:** calendars that render in JavaScript and happy-hour menus posted as images or PDFs yield nothing.
  That would need a headless browser or PDF text extraction.
- **WWOZ timing:** WWOZ gives only start times, so the RPC assumes 3h. A listing shown as "12:00am" is stored on the printed date,
  and may really belong to the night before.
- **Food trucks are thin (13 stops):** most NOLA trucks publish schedules only on Instagram or Facebook.
- **Pop-up hours:** pop-ups taken from brewery calendars sometimes show the whole event window rather than the vendor's own hours.
- **Duplicates:** some happenings are near-duplicates across sources (e.g. the same show from a venue site and WWOZ).
  The frontend hides exact duplicates (same place, title and start); ingest-level dedupe across `web:` and `wwoz:` rows is not done.
- **Map colors:** the map is heavily live-music (violet) in the evening, so the color mix is less varied than the mockup.
- **Changed titles:** if the LLM rewords a title after a page change, the item gets a new ID and the old row is marked stale.
- **Realtime not verified here:** the Realtime WebSocket could not be tested from the build sandbox (proxy). The 60s polling
  and refresh-on-focus fallback work.
- **Security advisor findings** (accepted and understood):
  - "RLS enabled, no policy" on internal tables is intentional: they are service-role only.
  - `report_wrong_info` is the intended public write path.
  - `pg_net` sits in the `public` schema (Supabase default).
  - `rls_auto_enable()` is a platform function not created by this build; it was left untouched.
- **MapTiler key:** it should be restricted to the production domain in the MapTiler dashboard (not possible via the API from here).

## Monthly cost estimate

About $17–22/month, plus $25 if the Supabase project is on Pro. See the README for the breakdown. First backfill:
about $2.70 Google Places, about $2.20 LLM.

## Admin password

It was generated during the build and given to the owner in the final session message. It is stored only as the Vercel
env var `ADMIN_PASSWORD` (sensitive) on project `tapmap`, and is not in git. To change it, edit that env var in
Vercel and redeploy.

## Credentials and where they live (names only)

- **Supabase function secrets:** `CRON_SECRET`, `AI_GATEWAY_API_KEY`, `TICKETMASTER_API_KEY`, `GOOGLE_PLACES_API_KEY`, feature flags.
- **Supabase Vault:** `cron_secret`, `project_url` (used by pg_cron).
- **Vercel env:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MAPTILER_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`.

---

# Multi-city expansion (2026-09-25)

The owner asked to cover any Louisiana city south of Monroe, loaded on demand when someone points at it,
using free OpenStreetMap data with Google filling in details. The work was split across three parallel
sub-agents (city loader, events/websites, frontend), with the lead doing schema, integration and docs.

## What was built

- **Schema** (`20260925000001_cities.sql`, `…0100_city_sync.sql`, `…0002_prewarm_cities.sql`, `…0900_cron_cities.sql`):
  - Tables: `cities` (484 Census places/CDPs with polygons), `app_settings`, and the `api_usage` spend ledger.
  - `venues.city_id` is set by a trigger from the polygon.
  - Public RPCs: `cities_in_view`, `city_status`, `search_cities`, `mark_city_viewed`, `request_city`.
  - Service RPCs: `claim_city_for_sync`, `venues_to_enrich`, `website_queue`, `active_cities`, `city_at`,
    `record_usage`, `budget_status`, `refresh_city_counts`, `kick_job`.
- **`city_sync`** edge function: osm → discover (only for thin OSM) → enrich → events, resumable.
  Google usage is limited to free IDs-only Text Search plus Enterprise Place Details, with the budget checked before each paid call.
- **`events_sync`:** Ticketmaster runs per active city, oldest first, with per-city sources rows (`tm:<city_id>`).
  Events are accepted anywhere inside an allowed city, and geocoding is city-aware. WWOZ stays New Orleans only.
- **`website_sync`:** reads `website_queue()` (hot cities; prewarm only when over budget), passes the venue's city to
  the prompt, and records LLM spend.
- **Frontend:**
  - City outlines, desktop hover tooltip, tap-to-select city card with Load/progress/error states, and city search.
  - The geolocation limit to near New Orleans is removed; minZoom is 6.5.
  - Admin → Coverage shows cities, spend and cap, with "Load now". Mock mode includes fake cities.
- **Cron:**
  - Added `tapmap_city_sync` (*/5) and `tapmap_website_sync_b` (:37).
  - `tapmap_events_tm` is now hourly (each city at most every 5h).
  - The weekly Google discovery `tapmap_places_sync` is removed.

## Verified

- **Kenner (OSM-rich):** 111 OSM elements → 91 venues, 67 enriched by Google, 43 websites, Ticketmaster events.
  Re-run: 0 inserted (idempotent).
- **Houma (thin OSM):** 2 venues from OSM → 57 after Google discovery (94 Details, 35 rejected as outside the polygon).
- **New Orleans Ticketmaster:** no regression (127 events; the query now uses the bbox midpoint so Uptown isn't missed).
- **Spend so far this month:** Google $0 (inside free tiers: 172 Details, 86 IDs-only searches), LLM ≈ $0.49.
- **Web:** eslint, tsc, vitest (31 tests) pass. Screenshots are in `docs/design/cities-*.png` (the NOLA view still matches the reference).

## Known gaps

- **Not deployed to Vercel production from this session:** the production deploy was blocked by the session's
  permission policy. The backend is live, but https://tapmap-two.vercel.app still runs the NOLA-only frontend until
  someone deploys `web/` (e.g. `vercel deploy --prod` from the repo root with project `tapmap`, or the Git integration).
- **Overpass (OSM) is flaky from Supabase:** 504s, 406s and timeouts. A failed city retries after 15 min; if Overpass
  fails again it falls back to Google discovery (capped at 150 Details). Slidell hit this during the prewarm.
- **OSM coverage in small towns is thin.** Discovery fills the gap, but about 37% of Details calls land outside
  irregular city polygons: IDs-only search has no location, so the polygon check happens after the paid call.
- **Pins need happenings:** a newly loaded city shows venues' Ticketmaster events right away, but happy hours only
  appear after `website_sync` reads its sites (two hourly batches of 40).
- **Food trucks and live-music calendars** (WWOZ, curated trucks) are New Orleans only.
- **Ticketmaster venues in unloaded cities:** the New Orleans radius also accepts events in allowed neighbours
  (Metairie, Westwego), which creates venues in cities that aren't loaded yet.
- **Tapping to select a city works at zoom ≤ 11.5.** Closer in, a "{city} isn't on TapMap yet · Load" pill is shown instead.
- **Real "Load" not pressed from the UI:** loads were exercised through `city_sync` and the prewarm queue,
  and the UI flow was tested in mock mode.
- **Admin Coverage tab untested against live data** (no service key in the sandbox); it needs one look after deploy.

## Prewarm result (checked 2026-09-25 03:40 UTC)

All 11 prewarm cities reached `ready`. Slidell failed once because Overpass was down, then loaded on its retry.

| City | Venues | Happenings (current) |
|---|---|---|
| New Orleans | 844 | 1,105 |
| Baton Rouge | 133 | 20 |
| Metairie | 129 | 5 |
| Lake Charles | 94 | 22 |
| Kenner | 92 | 32 |
| Lafayette | 86 | 44 |
| Mandeville | 80 | 36 |
| Houma | 57 | 37 |
| Covington | 50 | 26 |
| Hammond | 43 | 12 |
| Slidell | 37 | 7 |

- **Spend so far this month:** Google $0 (698 Details and 487 IDs-only searches, all inside the free tiers); LLM $1.59 (326 calls).
- **Happening counts** keep rising as `website_sync` works through the new cities' sites.
- **OSM is thinner outside New Orleans:** Baton Rouge's 133 venues is low for its size. Google discovery only runs when OSM
  keeps fewer than 25, so mid-size cities depend on OSM completeness. Raising that threshold, or running discovery for
  every city, would fill this in at about $0.02 per new venue.
