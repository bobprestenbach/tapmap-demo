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
