# Website extraction eval (`website_sync`)

Date: 2026-09-24 (America/Chicago). Model: `anthropic/claude-haiku-4.5` via Vercel AI Gateway.
Script: `scripts/eval/website_eval.ts`. It runs the same pipeline as the edge function
(`supabase/functions/website_sync/pipeline.ts`) but does not write to the DB.

```
DENO_CERT=/root/.ccr/ca-bundle.crt npx -y deno run -A scripts/eval/website_eval.ts            # built-in list of 15 well-known NOLA bars
DENO_CERT=/root/.ccr/ca-bundle.crt npx -y deno run -A scripts/eval/website_eval.ts --from-db  # 15 bars/music venues from the venues table
```

The script writes `website_extraction_auto.md` (per-venue tables, from the latest `--from-db` run)
and `website_extraction_results.json` (the same data without page text) to `docs/eval/`.

## How the pipeline works

1. `politeFetch` the homepage, which checks robots.txt (RFC 9309), sends the TapMapBot UA and waits at least 1.2 s between requests to the same host. If the fetch fails, it retries on the other host form (www vs. bare domain).
2. Find up to 3 same-host subpages by scoring link text and href: happy hour 12, specials/deals 9, events/calendar 7, music/live/entertainment 7, trivia/brunch/weekly 4, drinks 3, menu 2. PDFs, images, cart and login pages, careers, private events, catering and reservations are skipped.
   If no link or homepage text mentions happy hour, it guesses `/happy-hour`, `/specials` and `/events`. Soft 404s and redirects back to the homepage are dropped.
   If the fetched pages still show no happy-hour time, it follows one more happy-hour or specials link found on a subpage (depth 2). For example, Cure's `/menus` page links to "HAPPY HOUR".
3. Convert HTML to text. Lines already seen on an earlier page (nav, footer) are dropped. Budgets are 5k chars for the homepage, 7k per subpage and 17k in total (about 4-5k input tokens).
4. Parse JSON-LD `Event` / `MusicEvent` blocks directly, with no LLM. It keeps only events in Central time with a New Orleans address (chain sites list other cities) that fall within the next 60 days.
5. Take the sha256 of the text plus the JSON-LD signature. If it matches `sources.content_hash`, there is no LLM call; the job only touches `last_verified_at`. If the text has no time or day words at all (`no_schedule_text`), there is no LLM call either.
6. The LLM is prompted to return strict JSON (see `SYSTEM_PROMPT` in `pipeline.ts`). The prompt gives today's date and weekday in Chicago time.
7. Code-side validation:
   - Kinds are normalized, and times are parsed leniently ("4pm", "16:00", "noon").
   - Recurring items need days and a start time. Dated items need a start time and a date between today and 60 days out.
   - Monthly items ("first Saturday") are dropped as recurring. As one-offs they are kept only if the model's computed date really is that weekday and ordinal (`monthlyDateOk`).
   - A recurring item whose evidence is a single calendar date, with no "every/weekly/Mondays" wording, is dropped.
   - "All day" is honoured only for `special` items whose evidence says "all day" (stored as 00:00-23:59).
   - Confidence is clamped to 0-1. It is multiplied by 0.85 if the evidence quote only fuzzy-matches the page text and by 0.5 if the quote is missing. It is multiplied by 0.75 for "every day" schedules that the evidence doesn't state. Items below 0.4 are dropped.
   - A truncated JSON response is repaired by keeping only complete items.

## Run A: 15 well-known NOLA bars (built-in list, final code)

| Metric | Value |
|---|---|
| Venues | 15 |
| Venues with >=1 item | 7 |
| Items (happy hour / special / live music / event) | 53 (5 / 17 / 20 / 11) |
| Evidence quote found exact / fuzzy / missing | 43 / 10 / 0 |
| Pages fetched | 52 |
| LLM calls | 12 |
| Tokens in / out | 38,538 / 10,431 |
| Cost | $0.091 (about $0.0076 per LLM call) |

| Venue | Result | Notes (manual check against page text) |
|---|---|---|
| Bacchanal Wine | HH Mon-Fri 16-18; free wine tasting Wed 16-18 | Both correct: "Monday - Friday 4pm-6pm", "Every Wednesday from 4-6pm ... sips". |
| Barrel Proof | HH daily 16-18; $9 Sazerac Sun, Martini Mon, Frozen Marg Tue, Daiquiri Wed (all day); Bingo Wed 19-22 | HH correct ("4-6pm EVERYDAY $6 mini margs"). Day specials correct ("Sunday - Sazerac $9 all Day"). Bingo time is on the calendar. 4 food pop-ups with no stated time were dropped (correct). |
| Cane & Table | HH Mon-Fri 17-19 | Correct ("HAPPY HOUR Monday — Friday 5 PM - 7 PM"). |
| Erin Rose | "Wake Up and Live" daily 10-14; industry special Mon-Wed 23:00-close | Both correct, prices match. A Halloween event with no time was dropped (correct). |
| Maple Leaf Bar | 20 dated live-music shows over the next 2 weeks | Spot-checked 5: titles, dates and times match the calendar ("Naughty Professor Sep 25, 2026, 8:00 PM"). The JSON-LD copies were de-duplicated in favour of the LLM items. |
| Sidecar Patio & Oyster Bar | HH Mon-Fri 16-18; 5 dated specials/events | HH correct. "Sunday Brunch Special" has conf 0.5 because the page gives only a time and no offer, so it is borderline. The rest are correct. |
| Twelve Mile Limit | HH daily 17-19; 7 dated "$5 X all day" specials; karaoke Thu 21-01; comedy Mon 19:30; trivia Wed 20:00; 5 monthly parties as next-date one-offs | All correct. HH is listed under every date on the calendar. Monthly dates checked: last Sat Sep = 9/26, first Sat Oct = 10/3, 2nd Sat = 10/10, 3rd Sat = 10/17, last Tue Oct = 10/27. The model's titles use exclamation marks ("Trivia Night!"). |
| Cure | none | Correct: no scheduled items in the static HTML. The events page is private-event booking, and the happy-hour menu is a link to an image or PDF. |
| d.b.a. | none | The show calendar is a JS widget (`/shows` is 23 chars of text). |
| The Spotted Cat | none | The calendar is a JS widget (37 chars of text). |
| The Avenue Pub | none | Events widget says "No event found!". Only opening hours are listed. |
| Bar Tonique | none | The site redirects to an Adobe Express page with 284 chars of text. |
| Bayou Beer Garden | none (`no_text`) | Fully client-rendered site. |
| Mimi's in the Marigny, Pal's Lounge | `fetch_error` | TLS/502 errors from the sandbox proxy. They may work from Supabase. |

**Precision (Run A):** I read all 53 items against their evidence quotes (43 match the page text exactly and 10 fuzzily),
and spot-checked about 15 against the fetched page text. 52 look correct and 1 is borderline (the Sidecar "Sunday Brunch
Special" with no offer text, kept at 0.5). I found no invented times or days.
**Recall:** every venue whose static HTML actually shows a happy hour yielded it (6/6). The misses are all
JS-rendered calendars, images or PDFs.

## Run B: 15 bars/music venues sampled from the `venues` table (`--from-db`, final code)

| Metric | Value |
|---|---|
| Venues | 15 |
| Venues with >=1 item | 7 |
| Items (happy hour / special / live music / event) | 14 (7 / 0 / 3 / 4) |
| Evidence exact / fuzzy / missing / JSON-LD | 9 / 1 / 0 / 4 |
| LLM calls | 12 |
| Cost | $0.065 |

Details are in `website_extraction_auto.md`. Manual checks:
- **30°/-90°**: HH Mon-Thu 18-21 and Fri-Sun 16-19 came out as 2 rows. Correct ("Monday-Thursday 6p-9p / Friday-Sunday 4p-7p"). "Red Beans & Rice Mondays" has no time, so it was correctly dropped.
- **Restaurant & Bar at The Chloe**: Lobby Bar HH Mon-Thu 14-17 is correct. The Pool Bar HH "2:00pm - 5:00pm" has no days on the page. The model said daily, and the unstated-every-day penalty now lowers its confidence.
- **Superior Seafood**: HH daily 16:00-18:30. Correct ("Happy Hour: Daily from 4:00 - 6:30PM").
- **Rendezvous Tavern**: HH Mon-Fri 15-20 is correct. 4 Saints/Pelicans watch-party events came from JSON-LD; they were listed 4 times across pages, and de-duplication now keeps one of each.
- **The Jazz Playhouse**: Brass-A-Holics Thu 19:30-22:30 is correct. The HH "from open to 6pm" was turned into Tue-Sun 15:00-18:00 using the opening hours on the same page. That is reasonable but inferred.
- **Bamboula's**: only 1 upcoming show (Sep 24). The rest of the month's calendar is past or TBA, so this is correct.
- **The Joy Theater**: 1 show with doors and start times. 12 shows listed with dates but no times, and 5 beyond 60 days, were dropped (by design; Ticketmaster covers these).
- **Zero-yield**: the zero-yield venues are JS widgets (Spotted Cat, The Channel), sites with no schedule text (Boot Scootin, TJ Quill's, which redirects to another business), and Lucy's and Fat Tuesday (no happy hour on their sites).

**Precision (Run B):** 13/14 items are fully correct. 1 is inferred (the Chloe pool-bar days, now down-weighted).

## Known limitations

- JS-rendered calendars (Squarespace calendar blocks, Wix, Timely/ Eventbrite widgets) and happy-hour menus
  published as images or PDFs yield nothing. A headless browser or PDF text extraction would fix this, but both are out of MVP scope.
- Dated events without a start time are dropped, because the map can't compute "live now" without one.
- A special marked "all day" is stored as 00:00-23:59 rather than the venue's opening hours.
- Title wording can change between LLM runs. When a page changes, this creates a new `external_id`, and the old row is
  marked `is_stale` rather than updated.

## Full run over all website sources

See the "Full run" section below; it is filled in after the bulk run.
