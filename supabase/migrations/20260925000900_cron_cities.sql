-- Multi-city schedule. Replaces the weekly Google Text Search discovery (places_sync) with city_sync:
-- OSM discovery + Google Place Details enrichment, per city, resumable in 5-minute steps.
-- city_sync with no params picks next_city_for_sync(): queued/syncing cities, errored ones to retry,
-- then hot ready cities due for a refresh (prewarm every 7 days, others every refresh_days).
select cron.unschedule('tapmap_places_sync') where exists (select 1 from cron.job where jobname = 'tapmap_places_sync');
select cron.unschedule('tapmap_city_sync') where exists (select 1 from cron.job where jobname = 'tapmap_city_sync');
select cron.unschedule('tapmap_website_sync_b') where exists (select 1 from cron.job where jobname = 'tapmap_website_sync_b');

select cron.schedule('tapmap_city_sync', '*/5 * * * *', $$select private.invoke_job('city_sync')$$);
-- Second hourly website batch: more venues across cities (only hot cities are queued; LLM runs only on changed pages).
select cron.schedule('tapmap_website_sync_b', '37 * * * *', $$select private.invoke_job('website_sync', '{"limit":40,"concurrency":6}')$$);
-- Ticketmaster: hourly, but each run only pulls cities not refreshed in the last 5h (tm_min_age_h), oldest first,
-- so the prewarm + viewed cities spread across runs.
select cron.unschedule('tapmap_events_tm') where exists (select 1 from cron.job where jobname = 'tapmap_events_tm');
select cron.schedule('tapmap_events_tm', '23 * * * *', $$select private.invoke_job('events_sync', '{"adapters":["ticketmaster","seatgeek"]}')$$);
