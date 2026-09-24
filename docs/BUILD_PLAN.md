# TapMap MVP — Build Plan (hand-off brief)

This is the complete brief for the "Start the TapMap build" session. It was written in a
planning session with the owner (Bob). Treat it as the source of truth for scope, stack,
and design. If something here conflicts with reality (a key missing, an API changed),
adapt, note it in `docs/BUILD_LOG.md`, and keep going — the owner wants this done on
autopilot and will not be around to answer questions.

## Goal

A working, demo-able MVP of **TapMap**: a free mobile-first map showing what's happening
**right now** at hospitality businesses in **New Orleans** — bars, restaurants, food trucks,
live music, pop-ups, happy hours, events. All data is sourced automatically from public
information (no business-owner input yet). The owner should come back to:

1. A **live Vercel URL** that works as a PWA ("Add to Home Screen" on iPhone/Android).
2. A map styled like `docs/design/reference.webp`, populated with **real** New Orleans data.
3. A **"live now"** view that is correct for the current time (America/Chicago).
4. **Background refresh jobs** that keep data fresh with no session running.
5. A simple password-protected **admin page** to fix/hide bad data.
6. `README.md` explaining how it works, what each job does, and costs.

## Owner decisions (already made)

- **City:** New Orleans only (Orleans Parish; center ≈ 29.9511, -90.0715).
- **App form:** PWA (Next.js on Vercel). No App Store build yet.
- **Supabase:** use the owner's dedicated project **`tapmap-demo`** (ref `jombmjxzvpskjjxahmul`,
  us-east-1, created 2026-09-24). Do not create another project. **Never touch the other project
  `ochdiylnsiiszxprwqdj`** ("bobprestenbach's Project") — it belongs to a different app
  (courses, lessons, community, etc.).
- **Budget:** keep total running cost under ~$50/month. Cache Google Places aggressively; only
  re-run LLM extraction when a page's content hash changes.
- **Venue seed list:** owner gave none — curate ~150 venues (French Quarter, Frenchmen St,
  Marigny, Bywater, CBD, Warehouse District, Magazine St, Uptown, Mid-City, Garden District)
  and ~40 food trucks yourself.
- **UI:** must look like the reference mockup (see Design section). This is a hard requirement.

## Credentials available (environment variables)

| Variable | Status | Use |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | provided | Places API (New): venue list, hours, location, website |
| `SUPABASE_ACCESS_TOKEN` | provided | Supabase CLI: deploy edge functions, set function secrets, migrations |
| `TICKETMASTER_API_KEY` | provided | Discovery API: concerts/events near NOLA |
| `MAPTILER_API_KEY` | provided | Dark vector basemap tiles |
| `VERCEL_TOKEN` | provided | Deploy the web app, set Vercel env vars via API |
| `AI_GATEWAY_API_KEY` | provided | Vercel AI Gateway → Anthropic model for LLM extraction (use a Haiku-class model) |
| `SEATGEEK_CLIENT_ID` | **NOT available** | Skip SeatGeek. Build the adapter behind a flag so it can be enabled later. |
| `META_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID` | **NOT available** | Skip Instagram. Build the Business Discovery adapter behind a flag, disabled. Food trucks come from websites / public schedules instead. |

Never commit secrets. Server-side keys live in Supabase function secrets and Vercel env vars.
Only the MapTiler key and Supabase anon/publishable key may be exposed to the browser
(restrict MapTiler key by domain if possible).

## Architecture

```
Scheduler: Supabase pg_cron → invokes Supabase Edge Functions (NOT Vercel cron; Hobby = daily only)
  weekly      places_sync     Google Places → venues
  daily       website_sync    venue websites → hash → (if changed) LLM → happenings (happy hours, specials, recurring events)
  every 6h    events_sync     Ticketmaster + WWOZ Livewire + local listings + venue event pages → happenings
  every 30m   trucks_sync     food truck websites / public schedule pages → truck_stops (10am–midnight CT)
  nightly     expire_stale    un-verified >14 days → drop "live" eligibility
      ↓
Postgres + PostGIS:  venues · happenings · sources · raw_pages · sync_runs
      ↓
RPC: happenings_near(lat, lng, radius_m, at timestamptz, categories text[])
      → live-now + starting-within-2h items, with distance, computed from recurrence rules
      ↓
Next.js PWA (MapLibre GL + MapTiler dark style) + Supabase Realtime for new pins
```

"Live now" is computed at query time from stored schedules (e.g. happy hour Mon–Fri 16:00–19:00
America/Chicago), not by scraping constantly.

### Data model (starting point — refine as needed)
- `venues`: id, google_place_id, name, category (`restaurant|bar|food_truck|music_venue|popup`),
  location geography(Point), address, neighborhood, website, instagram, phone, price_level,
  rating, opening_hours jsonb, photo_ref, is_hidden, created_at, updated_at
- `happenings`: id, venue_id, kind (`happy_hour|special|live_music|event|truck_stop|popup`),
  title, description, price_text, starts_at, ends_at (one-offs) OR recurrence (days_of_week int[],
  start_time, end_time), location override (for trucks), source_id, source_url, confidence 0–1,
  last_verified_at, is_hidden
- `sources`: id, kind, url, venue_id, cadence, last_run_at, last_status, content_hash
- `raw_pages`: source_id, fetched_at, content_hash, text (keep for reprocessing)
- `sync_runs`: job, started_at, finished_at, ok, counts jsonb, error
- RLS: public read on venues/happenings where not hidden; writes only via service role.

### Data sources for MVP
- Google Places API (New) Text/Nearby Search over a grid of NOLA neighborhoods → bars, restaurants.
  Use field masks to keep costs down.
- Venue websites (from Places) → find happy-hour/specials/events pages → extract with LLM to strict JSON.
  Respect robots.txt, identify with a polite User-Agent, rate-limit.
- Ticketmaster Discovery API (latlong + radius, next 14 days).
- WWOZ Livewire music calendar (wwoz.org) and other local listings (OffBeat, Gambit/NOLA.com) —
  check robots/terms; if disallowed, skip and log.
- Food trucks: curated list of ~40 NOLA trucks with their websites/schedule pages; extract
  scheduled stops. Show "posted Xh ago" freshness.
- Venue matching: fuzzy name + distance (<150 m) to attach events to venues.

## Design (hard requirement)

**Reference:** `docs/design/reference.webp`. Match its look closely. (The small gray toolbar at the
bottom-center of the screenshot is a screenshot-annotation overlay — NOT part of the UI.)

- **Theme:** very dark navy/indigo UI (≈ `#0B0A1F`–`#120F2E`), dark vector basemap with muted streets,
  dark water (MapTiler "dataviz-dark"/"streets-v2-dark" or custom-tuned MapLibre style).
- **Header:** "TapMap" wordmark top-left, bold, blue→violet→pink gradient text. Top-right pill
  "● N live now" with green dot, dark fill, subtle violet border; N = actual live count in view.
- **Search bar:** full-width, rounded (≈14px radius), dark indigo fill, thin violet border,
  magnifier icon, placeholder **"What's poppin' near you?"**.
- **Filter chips row** (horizontally scrollable, pill-shaped, dark fill, thin border, emoji + label):
  `(( ● )) Live`, `🍽️ Restaurants`, `🚚 Food Trucks`, `🍸 Bars`, `🎷 Live Music`, `✨ Pop-Ups`.
  Selected chip gets a glowing border in its category color.
- **Markers:** circular dark-filled badges with the category emoji centered, **double neon ring +
  outer glow** in the category color:
  - Restaurants: magenta/pink (`#E040FB`-ish)
  - Bars: cyan (`#22D3EE`-ish)
  - Food trucks: amber/orange (`#F59E0B`-ish)
  - Live music: violet (`#8B5CF6`-ish)
  - Pop-ups: neon green (`#4ADE80`-ish)
  - Items live right now get a slow pulsing glow; upcoming ones are dimmer.
- **User location:** cyan/blue dot with white ring.
- **Bottom sheet:** rounded-top dark panel peeking from the bottom (drag up to expand) listing
  what's live nearby, sorted by distance ("Your city live" / nearby list). Tapping a marker or
  list item opens a detail card: name, what's happening, time window ("Happy hour until 7pm"),
  price text, distance, "Directions" (Apple/Google Maps deep link), website, source + "verified X ago",
  "Report wrong info" button.
- **Font:** modern geometric sans (Manrope or Plus Jakarta Sans via Google Fonts).
- Mobile-first (390×844 baseline), safe-area insets, no horizontal scroll, marker clustering when zoomed out.
- PWA: manifest, icons, theme color, standalone display, offline shell.

## Workstreams (run in parallel with sub-agents, then integrate)

1. **DB & API** — in Supabase project `tapmap-demo` (`jombmjxzvpskjjxahmul`): migrations (PostGIS, tables, RLS,
   `happenings_near` RPC with recurrence + America/Chicago handling), seed categories. Tests for the RPC.
2. **Venue import** — `places_sync` edge function + one-time backfill; neighborhood grid; dedupe.
3. **Website extraction** — fetcher, content hashing, LLM extraction prompt with strict JSON schema
   (via AI Gateway), confidence scoring, `website_sync` function. Eval on 15 real NOLA bars.
4. **Events** — Ticketmaster adapter, WWOZ/local listings adapter, venue calendar extraction,
   venue matching, `events_sync`. SeatGeek adapter stubbed behind flag.
5. **Food trucks & pop-ups** — curated truck list, schedule extraction, `trucks_sync`.
   Instagram Business Discovery adapter stubbed behind flag.
6. **Frontend PWA** — Next.js + MapLibre + MapTiler, pixel-close to the reference, Realtime updates,
   bottom sheet, detail card, admin page (password from env `ADMIN_PASSWORD`, generate one and
   put it in the final report — not in git).

Then **Integration & QA**: schedule all jobs with pg_cron, run every job once for real, deploy to
Vercel production, verify on a 390px viewport with Playwright (screenshot vs reference), check
live-now correctness at several times of day, verify costs/quotas, write README + BUILD_LOG.

## Definition of done

- [ ] Production URL loads on a phone, installable as PWA, looks like the reference.
- [ ] ≥150 real venues, ≥50 real happy hours/specials, ≥30 upcoming events, some food truck stops.
- [ ] "N live now" is correct for the current Central time.
- [ ] All sync jobs scheduled in pg_cron and have succeeded at least once (`sync_runs`).
- [ ] Admin page can hide/edit a happening.
- [ ] Lint/typecheck/tests pass; no secrets in git.
- [ ] README + `docs/BUILD_LOG.md` (what was built, what was skipped and why, known gaps,
      monthly cost estimate, admin password location).
- [ ] Final message to owner: the URL, how to add to home screen, what to demo, known limitations.

## Git

Work on the session's designated branch, commit often with clear messages, push when done.
