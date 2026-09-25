# TapMap

A free, mobile-first map of what's happening **right now** at New Orleans bars, restaurants,
music venues, food trucks and pop-ups. All the data comes from public sources, filled in and refreshed automatically.

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
| `places_sync` | Mon 08:17 | Google Places Text Search over 13 neighborhoods (bars, restaurants, live music), merged with OSM by name + distance. Each neighborhood is cached for 6 days. Creates a `sources` row for every venue website. | `{"provider":"google"\|"osm"\|"curated","force":true}` |
| `website_sync` | hourly :07 | Fetches the homepage plus up to 3 relevant subpages and parses JSON-LD events. It calls the LLM **only when the page hash changed** (and at most every 72h per site). Output is validated (evidence quote must appear on the page, schedule required). Items that disappear are marked stale. | `{"limit":40,"concurrency":6,"force":true}` |
| `events_sync` | every 6h (:23 Ticketmaster, :41 WWOZ) | Ticketmaster events within 15 mi for 14 days, and the WWOZ Livewire calendar (10s crawl delay). Matches each event to a venue by name + distance or address, creating the venue if needed. De-dupes Ticketmaster against WWOZ. | `{"adapters":["ticketmaster","wwoz","seatgeek"],"days":4}` |
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

## Monthly cost estimate (target < $50)

| Item | Estimate |
|---|---|
| Google Places API: about 80 Text Search requests/week, with a 6-day cache per neighborhood | ~$11–12 list price (usually covered by Google Maps Platform's free monthly usage) |
| Claude Haiku 4.5 via Vercel AI Gateway: runs only on changed pages, at most once every 72h per site | ~$5–10 (worst case ~$19) |
| Supabase: about 2,600 edge function invocations/month, small DB | $0 on Free (well within limits); $25 if on Pro |
| Vercel Hobby, Ticketmaster, WWOZ, OSM, Census geocoder | $0 |
| MapTiler: free tier is 100k tile requests/month | $0 for demo traffic; paid plan if usage grows |
| **Total** | **≈ $17–22/month** (+$25 if Supabase Pro) |

The first full backfill cost about $2.70 (Google) and about $2.20 (LLM, including evals).
