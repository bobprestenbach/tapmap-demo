-- Schedule sync jobs with pg_cron -> pg_net -> Edge Functions.
-- Secrets (cron_secret, project_url) live in Supabase Vault, created out-of-band (never in git):
--   select vault.create_secret('<random>', 'cron_secret');
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.invoke_job(fn text, body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  base text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret');
begin
  return net.http_post(
    url := base || '/functions/v1/' || fn,
    body := body,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 300000
  );
end $$;
revoke all on function private.invoke_job(text, jsonb) from public, anon, authenticated;

-- Idempotent (re)scheduling
do $$
declare j record;
begin
  for j in select jobname from cron.job where jobname like 'tapmap_%' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- Times are UTC. America/Chicago = UTC-5 (CDT) / UTC-6 (CST).
select cron.schedule('tapmap_places_sync',  '17 8 * * 1',     $$select private.invoke_job('places_sync')$$);             -- weekly, Mon ~3am CT
select cron.schedule('tapmap_website_sync', '7 * * * *',      $$select private.invoke_job('website_sync', '{"limit":15}')$$); -- hourly batches => every site ~daily
select cron.schedule('tapmap_events_tm',    '23 */6 * * *',   $$select private.invoke_job('events_sync', '{"adapters":["ticketmaster","seatgeek"]}')$$);
select cron.schedule('tapmap_events_wwoz',  '41 */6 * * *',   $$select private.invoke_job('events_sync', '{"adapters":["wwoz"],"days":4}')$$);
select cron.schedule('tapmap_trucks_sync',  '*/30 * * * *',   $$select private.invoke_job('trucks_sync')$$);
select cron.schedule('tapmap_expire_stale', '13 9 * * *',     $$select private.invoke_job('expire_stale')$$);            -- nightly ~4am CT
-- keep pg_net response table small
select cron.schedule('tapmap_net_cleanup',  '0 10 * * *',     $$delete from net._http_response where created < now() - interval '2 days'$$);
