-- city_sync support: atomic city claim (no two invocations work the same city), venues awaiting
-- Google enrichment, and a service-role wrapper to poke other jobs through pg_net.

-- Claim a city for one city_sync step. With p_city_id, claims that city; otherwise picks like
-- next_city_for_sync() (queued/syncing, then errored retries, then hot ready cities due a refresh).
-- A city another invocation touched in the last 150 s while 'syncing' is skipped. The claimed city gets
-- status='syncing', last_attempt_at=now(), and phase reset to 'osm' when it is starting a new cycle.
-- Returns the city id, or null when there is nothing to do.
create or replace function public.claim_city_for_sync(p_city_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  cid text;
begin
  if p_city_id is not null then
    select c.id into cid from public.cities c
     where c.id = p_city_id
       and not (c.status = 'syncing' and c.last_attempt_at > now() - interval '150 seconds')
     for update skip locked;
  else
    select q.id into cid from (
      select c.id, 0 as pri, coalesce(c.requested_at, 'epoch') as t from public.cities c
       where c.status in ('queued', 'syncing')
         and not (c.status = 'syncing' and c.last_attempt_at > now() - interval '150 seconds')
      union all
      select c.id, 1, c.last_attempt_at from public.cities c
       where c.status = 'error' and c.attempts < 5 and coalesce(c.last_attempt_at, 'epoch') < now() - interval '15 minutes'
      union all
      select c.id, 2, coalesce(c.refreshed_at, 'epoch') from public.cities c
       where c.status = 'ready' and public.city_is_hot(c.prewarm, c.last_viewed_at)
         and coalesce(c.refreshed_at, 'epoch') < now() - make_interval(days =>
               case when c.prewarm then 7 else (public.setting('refresh_days'))::int end)
    ) q
    join public.cities c2 on c2.id = q.id
    order by q.pri, q.t
    limit 1
    for update of c2 skip locked;
  end if;
  if cid is null then return null; end if;
  update public.cities set
    phase = case when status in ('none', 'ready') or phase is null or phase = 'done' then 'osm' else phase end,
    status = 'syncing',
    last_attempt_at = now()
  where id = cid;
  return cid;
end $$;
revoke all on function public.claim_city_for_sync(text) from public, anon, authenticated;
grant execute on function public.claim_city_for_sync(text) to service_role;

-- Venues in a city still waiting for Google enrichment (no website, never enriched, visible).
create or replace function public.venues_to_enrich(p_city_id text, p_limit int default 200)
returns table (id uuid, name text, lat double precision, lng double precision, address text, phone text,
               price_level int, rating numeric, opening_hours jsonb, google_place_id text, website text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.name, extensions.st_y(v.location::extensions.geometry), extensions.st_x(v.location::extensions.geometry),
         v.address, v.phone, v.price_level, v.rating, v.opening_hours, v.google_place_id, v.website
  from public.venues v
  where v.city_id = p_city_id and v.enriched_at is null and v.website is null and not v.is_hidden
    and v.location is not null
  order by v.created_at
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke all on function public.venues_to_enrich(text, int) from public, anon, authenticated;
grant execute on function public.venues_to_enrich(text, int) to service_role;

-- Fire-and-forget another edge function via pg_net (private.invoke_job reads the cron secret from the
-- vault, so edge functions never need to hold it). Only a fixed list of jobs may be poked.
create or replace function public.kick_job(p_fn text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  if p_fn not in ('events_sync', 'website_sync', 'city_sync') then
    raise exception 'kick_job: % not allowed', p_fn;
  end if;
  return private.invoke_job(p_fn, coalesce(p_body, '{}'::jsonb));
end $$;
revoke all on function public.kick_job(text, jsonb) from public, anon, authenticated;
grant execute on function public.kick_job(text, jsonb) to service_role;

-- Google Details per city per cycle for the enrich phase: 600 -> 300 (keeps prewarm under the monthly cap).
-- Only replaces the original default, so a value changed later in the admin is left alone.
update public.app_settings set value = '300'::jsonb, updated_at = now()
 where key = 'enrich_max_per_city' and value = '600'::jsonb;
