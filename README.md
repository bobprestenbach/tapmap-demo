# TapMap

A free, mobile-first map of what's happening **right now** at bars, restaurants, music venues,
food trucks and pop-ups. It started in New Orleans; any Louisiana city south of Monroe can now be loaded
on demand (see "Cities" below). All the data comes from public sources, filled in and refreshed automatically.

- **Live app:** https://tapmap-two.vercel.app (a PWA; use "Add to Home Screen" on iPhone or Android)
- **Admin:** https://tapmap-two.vercel.app/admin (password in the Vercel env var `ADMIN_PASSWORD`)
- **Design reference:** `docs/design/reference.webp`. Production screenshot: `docs/design/screenshot-prod-390.png`

## How it works

```
Supabase pg_cron ──> pg_net ──> Supabase Edge Functions (Deno)
  weekly     places_sync    Google Places (New) + OpenStreetMap + curated list  -> venues, website sources
  hourly     website_sync   venue websites -> hash -> (changed?) Claude Haiku  -> happy hours, specials, events
  every 6h   events_sync    Ticketmaster Discovery + WWOZ Livewire (+ SeatGeek, off)  -> events / live music
  every 30m  trucks_sync    curated trucks, brewery/pop-up calendars (+ Instagram, off) -> truck stops, pop-ups
  nightly    expire_stale   un-verified >14 days -> not live; old one-offs hidden; raw page pruning
        │
Postgres + PostGIS: venues · happenings · sources · raw_pages · sync_runs · reports
        │
RPC happenings_near(lat, lng, radius_m, at, categories, upcoming_window)
  -> live-now + starting-soon items, computed at query time from stored schedules in America/Chicago
        │
Next.js PWA on Vercel (web/): MapLibre GL + MapTiler dark style, Supabase Realtime, admin API routes
```

"Live now" isn't scraped continuously. Each happening stores either a one-off window (`starts_at`/`ends_at`)
or a weekly rule (`days_of_week` + `start_time`/`end_time`, in Chicago wall-clock time; an end at or before the start
means the window runs past midnight). `happenings_near` expands these rules for yesterday, today and tomorrow and
converts them with `AT TIME ZONE 'America/Chicago'`, so daylight-saving changes and overnight windows are handled correctly.

## Cities (multi-city, on demand)

- `cities` holds Census outlines for 484 Louisiana cities, towns and CDPs (loaded with
  `node scripts/cities/load_places.mjs 22 LA`). A city is **allowed** when it's in `allowed_state` and its
  center is at or below `allowed_max_lat` (32.40, i.e. south of Monroe, so Shreveport, Bossier, Monroe and Ruston are out).
- **App:** the map draws city outlines from zoom 7. Desktop hover shows a tooltip. A tap opens a city card
  (ready → counts, not loaded → "Load {city}", loading → phase progress). City names also show up in search.
- `request_city()` (public) checks allowed area, the hourly limit (`city_requests_per_hour`, 12) and budget,
  then queues the city and pokes `city_sync`.
- **`city_sync`** (every 5 min, resumable) walks each city through these phases:
  - `osm`: OpenStreetMap Overpass, free. Finds bars, restaurants and music venues inside the city polygon; chains are skipped.
  - `discover`: runs only when OSM kept fewer than 25 venues, or Overpass is down on a retry. Free Google
    "IDs Only" Text Search, then Place Details only for new ids, max 150 per city.
  - `enrich`: for venues with no website, a free IDs-only search, then Place Details to get website, hours,
    phone and rating. Name and distance are verified. Max `enrich_max_per_city` (300).
  - `events`: Ticketmaster for the city, plus the city's websites queued for `website_sync`.
- **Freshness:** prewarm cities (New Orleans, Metairie, Kenner, Baton Rouge, Lafayette, Lake Charles, Slidell,
  Mandeville, Covington, Hammond, Houma) refresh weekly. Other cities refresh every `refresh_days` (30) while
  someone has viewed them in the last `cold_after_days` (14). Cold cities keep their data but stop being refreshed.
- **Spend:** every Google and LLM call is recorded in `api_usage` with the free tiers applied (`budget_status()`).
  With under $1 left of `monthly_cap_usd` ($75), city requests are refused, Google Details stops, and
  `website_sync` only processes prewarm cities. Cap, spend and coverage are in `/admin` → Coverage.

## Repository layout

| Path | What |
|---|---|
| `supabase/migrations/` | Schema, RLS, the `happenings_near` RPC, helper tables, the pg_cron schedule |
| `supabase/tests/happenings_near.sql` | RPC regression test (runs in a transaction; every row must be `pass = true`) |
| `supabase/functions/_shared/` | Job wrapper (auth + `sync_runs`), polite fetch (robots.txt, UA, rate limit), LLM, geo helpers |
| `supabase/functions/<job>/` | The five sync jobs |
| `data/venues/curated.json`, `data/trucks/trucks.json` | Curated seed lists (well-known venues; about 55 trucks and pop-ups plus their host venues) |
| `web/` | Next.js PWA + `/admin` |
| `docs/eval/website_extraction.md` | Extraction eval on 30 real NOLA bars |
| `docs/BUILD_LOG.md` | What was built, what was skipped, known gaps, costs |
| `scripts/` | `deploy-function.sh`, `invoke.sh`, venue backfill and eval scripts |

## The jobs

| Job | Schedule (UTC) | What it does | Main params |
|---|---|---|---|
| `city_sync` | every 5 min | Loads/refreshes one city per step: OSM venues → (thin OSM) Google discovery → Google Place Details for venues without a website → Ticketmaster + website queue. Resumable; see "Cities". | `{"city_id":"2240735"}` |
| `places_sync` | manual only | Legacy NOLA importer. Default provider is now `osm`; Google Text Search discovery runs only with `{"provider":"google"}`. | `{"provider":"osm"\|"google"\|"curated"}` |
| `website_sync` | hourly :07 and :37 | Takes sites from `website_queue()` (never-run first; hot cities only). Fetches the homepage plus up to 3 relevant subpages and parses JSON-LD events. It calls the LLM **only when the page hash changed** (and at most every 72h per site). Output is validated (evidence quote must appear on the page, schedule required). Items that disappear are marked stale. | `{"limit":40,"concurrency":6,"force":true}` |
| `events_sync` | hourly :23 Ticketmaster (each city at most every 5h), every 6h :41 WWOZ | Ticketmaster events for every active city (radius covers the city, 5–25 mi) for 14 days, kept only when the venue is inside an allowed city; and the WWOZ Livewire calendar (10s crawl delay). Matches each event to a venue by name + distance or address, creating the venue if needed. De-dupes Ticketmaster against WWOZ. | `{"adapters":["ticketmaster","wwoz","seatgeek"],"days":4}` |
| `trucks_sync` | every 30 min | Curated trucks and pop-ups, StreetFoodFinder, brewery calendars (Mato pages), truck sites. Changed pages go to the LLM. Stops are geocoded (curated hosts → Census geocoder → Nominatim) and clamped to 10am–midnight CT. | `{"limit":30}` |
| `expire_stale` | daily 09:13 | Recurring items not re-verified in 14 days are marked stale (and un-staled when re-seen). One-offs that ended more than 2 days ago are hidden. `raw_pages` older than 30 days are pruned. | `{"recurring_days":14}` |

Every run writes a row to `sync_runs` (job, ok, counts, error). The jobs authenticate with an `x-cron-secret` header.
The secret lives in Supabase Vault (for pg_cron) and in the function secrets (never in git).

Run a job by hand:
```bash
CRON_SECRET=... scripts/invoke.sh events_sync '{"adapters":["wwoz"],"days":1}'
```
Deploy a function: `scripts/deploy-function.sh website_sync` (needs `SUPABASE_ACCESS_TOKEN`).

## Configuration

**Supabase function secrets:** `CRON_SECRET`, `AI_GATEWAY_API_KEY`, `TICKETMASTER_API_KEY`, `GOOGLE_PLACES_API_KEY`,
`ENABLE_GOOGLE_PLACES=true`, `ENABLE_SEATGEEK=false` (+ `SEATGEEK_CLIENT_ID`), `ENABLE_INSTAGRAM=false`
(+ `META_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`). Optional: `EXTRACTION_MODEL` (default `anthropic/claude-haiku-4.5`).

**Vercel project `tapmap`** (root directory `web`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(publishable key), `NEXT_PUBLIC_MAPTILER_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_PASSWORD`.
Only the MapTiler key and the publishable Supabase key reach the browser. It's worth restricting the MapTiler key to
`tapmap-two.vercel.app` in the MapTiler dashboard.

**Security:** RLS is on for every table. The public can read only non-hidden venues and happenings.
Internal tables (`sources`, `raw_pages`, `sync_runs`, `reports`, caches) have no public policies. The only anonymous write
is `report_wrong_info()`. Admin routes check an httpOnly HMAC-signed cookie and use the service-role key server-side.

## Local development

```bash
cd web && npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000   (?mock=1 for mock data in dev)
npm run lint && npm run typecheck && npm test
```
Edge functions: `npx -y deno check supabase/functions/<name>/index.ts`.

## Monthly cost estimate (cap: $75, enforced in code)

| Item | Estimate |
|---|---|
| Google Places: free IDs-only Text Search, plus Place Details ($20/1000 after 1,000 free a month), only for venues OSM lists without a website and for thinly mapped towns. Recorded in `api_usage` | $0–30 (prewarm of 11 metros is ~1,500–2,500 Details once; refreshes only buy new venues) |
| Claude Haiku 4.5 via Vercel AI Gateway: runs only on changed pages, at most once every 72h per site; hot cities only | ~$10–40, growing with the number of viewed cities |
| Supabase: about 12k edge function invocations/month (city_sync every 5 min is mostly no-op) | $0 on Free; $25 if on Pro |
| Vercel Hobby, Ticketmaster, WWOZ, OSM, Census (outlines + geocoder) | $0 |
| MapTiler: free tier is 100k tile requests/month | $0 for demo traffic; paid plan if usage grows |
| **Total** | **≈ $20–70/month**, hard-capped by `monthly_cap_usd` (+$25 if Supabase Pro) |

The first NOLA backfill cost about $2.70 (Google Text Search) and about $2.20 (LLM). A new small city costs
about $0–3 in Google (free while under 1,000 Details a month); a Baton Rouge–sized city about $6 at most (300 Details).
