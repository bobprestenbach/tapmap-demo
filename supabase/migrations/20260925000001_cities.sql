-- Multi-city coverage: Census city/CDP polygons, on-demand city loading, spend ledger + monthly cap.
--
-- Flow: the app shows city outlines (cities_in_view). Tapping/hovering one shows its status; "Load city"
-- calls request_city(), which (if allowed, under the rate limit and under budget) queues the city and
-- pokes the city_sync edge function. city_sync walks phases osm -> enrich -> events -> done.
-- Cities nobody has viewed for cold_after_days stop being refreshed (except prewarm cities).

-- ---------------------------------------------------------------------------
-- settings (service role only)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;

insert into public.app_settings (key, value) values
  ('monthly_cap_usd',        '75'),
  ('allowed_state',          '"LA"'),
  ('allowed_max_lat',        '32.40'),   -- "south of Monroe": excludes Shreveport, Bossier, Monroe, Ruston
  ('city_requests_per_hour', '12'),
  ('cold_after_days',        '14'),
  ('refresh_days',           '30'),      -- ready cities re-run OSM/enrichment this often (prewarm: 7)
  ('enrich_max_per_city',    '600'),
  -- Google Places API (New) list prices (per 1000) and monthly free calls per SKU.
  ('sku_prices', '{
     "google_text_ids":          {"per_1000": 0,  "free": 0},
     "google_text_pro":          {"per_1000": 32, "free": 5000},
     "google_text_enterprise":   {"per_1000": 35, "free": 1000},
     "google_details_enterprise":{"per_1000": 20, "free": 1000}
   }')
on conflict (key) do nothing;

create or replace function public.setting(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select value from public.app_settings where key = p_key
$$;
revoke all on function public.setting(text) from public, anon, authenticated;
grant execute on function public.setting(text) to service_role;

-- ---------------------------------------------------------------------------
-- api_usage: spend ledger (Google, LLM). est_usd already accounts for free tiers.
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  service text not null,          -- google | llm
  sku text not null,              -- google_details_enterprise | google_text_ids | haiku | ...
  units int not null default 0,
  est_usd numeric(10,4) not null default 0,
  city_id text,
  job text
);
create index if not exists api_usage_at_idx on public.api_usage (at);
alter table public.api_usage enable row level security;

-- First instant of the current month in America/Chicago.
create or replace function public.month_start()
returns timestamptz language sql stable set search_path = '' as $$
  select (date_trunc('month', now() at time zone 'America/Chicago')) at time zone 'America/Chicago'
$$;

-- Record usage. When p_usd is null the cost is computed from sku_prices, charging only the
-- part of this month's running total that is above the SKU's free allowance.
create or replace function public.record_usage(
  p_service text, p_sku text, p_units int, p_usd numeric default null, p_city_id text default null, p_job text default null
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  price jsonb := public.setting('sku_prices') -> p_sku;
  before_units int;
  usd numeric;
begin
  if p_units is null or p_units <= 0 then
    if coalesce(p_usd, 0) = 0 then return 0; end if;
  end if;
  if p_usd is not null then
    usd := p_usd;
  elsif price is null then
    usd := 0;
  else
    select coalesce(sum(units), 0) into before_units from public.api_usage
     where sku = p_sku and at >= public.month_start();
    usd := (greatest(0, before_units + p_units - (price->>'free')::int)
            - greatest(0, before_units - (price->>'free')::int)) * (price->>'per_1000')::numeric / 1000;
  end if;
  insert into public.api_usage (service, sku, units, est_usd, city_id, job)
  values (p_service, p_sku, coalesce(p_units, 0), usd, p_city_id, p_job);
  return usd;
end $$;
revoke all on function public.record_usage(text, text, int, numeric, text, text) from public, anon, authenticated;
grant execute on function public.record_usage(text, text, int, numeric, text, text) to service_role;

create or replace function public.budget_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cap_usd', (public.setting('monthly_cap_usd'))::numeric,
    'spent_usd', coalesce((select sum(est_usd) from public.api_usage where at >= public.month_start()), 0),
    'remaining_usd', (public.setting('monthly_cap_usd'))::numeric
                     - coalesce((select sum(est_usd) from public.api_usage where at >= public.month_start()), 0),
    'by_sku', coalesce((select jsonb_object_agg(sku, jsonb_build_object('units', u, 'usd', d))
                          from (select sku, sum(units) u, sum(est_usd) d from public.api_usage
                                 where at >= public.month_start() group by sku) s), '{}'::jsonb)
  )
$$;
revoke all on function public.budget_status() from public, anon, authenticated;
grant execute on function public.budget_status() to service_role;

-- ---------------------------------------------------------------------------
-- cities: Census incorporated places + CDPs (TIGERweb), loaded by scripts/cities/load_places.sh
-- ---------------------------------------------------------------------------
create table if not exists public.cities (
  id text primary key,                     -- Census GEOID, e.g. '2255000' = New Orleans
  name text not null,                      -- 'New Orleans'
  full_name text,                          -- 'New Orleans city'
  kind text,                               -- city | town | village | cdp
  state text not null default 'LA',
  geom extensions.geometry(MultiPolygon, 4326) not null,
  center extensions.geography(Point, 4326) not null,
  area_km2 numeric,
  status text not null default 'none' check (status in ('none','queued','syncing','ready','error')),
  phase text,                              -- osm | enrich | events | done
  prewarm boolean not null default false,
  attempts int not null default 0,
  last_error text,
  last_attempt_at timestamptz,             -- last city_sync step (error retry backoff)
  requested_at timestamptz,
  last_viewed_at timestamptz,
  synced_at timestamptz,                   -- first time it became ready
  refreshed_at timestamptz,                -- last completed sync
  venue_count int not null default 0,
  counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists cities_geom_idx on public.cities using gist (geom);
create index if not exists cities_status_idx on public.cities (status);
create index if not exists cities_name_trgm_idx on public.cities using gin (name extensions.gin_trgm_ops);
alter table public.cities enable row level security;   -- read through the RPCs below
create trigger cities_touch before update on public.cities
  for each row execute function public.touch_updated_at();

create or replace function public.city_allowed(p_state text, p_center extensions.geography)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_state = (public.setting('allowed_state') #>> '{}')
     and extensions.st_y(p_center::extensions.geometry) <= (public.setting('allowed_max_lat'))::numeric
$$;
revoke all on function public.city_allowed(text, extensions.geography) from public;
grant execute on function public.city_allowed(text, extensions.geography) to anon, authenticated, service_role;

-- A city is "hot" (kept fresh) when prewarmed or viewed recently.
create or replace function public.city_is_hot(p_prewarm boolean, p_last_viewed timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_prewarm or coalesce(p_last_viewed > now() - make_interval(days => (public.setting('cold_after_days'))::int), false)
$$;
revoke all on function public.city_is_hot(boolean, timestamptz) from public;
grant execute on function public.city_is_hot(boolean, timestamptz) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- venues.city_id (auto-assigned from the polygon) + Google enrichment bookkeeping
-- ---------------------------------------------------------------------------
alter table public.venues add column if not exists city_id text references public.cities(id) on delete set null;
alter table public.venues add column if not exists enriched_at timestamptz;
alter table public.venues add column if not exists enrich_status text;   -- ok | no_match | mismatch | duplicate | error
create index if not exists venues_city_idx on public.venues (city_id);

create or replace function public.venues_set_city() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.location is not null and (new.city_id is null or tg_op = 'UPDATE' and new.location is distinct from old.location) then
    select c.id into new.city_id from public.cities c
     where extensions.st_covers(c.geom, new.location::extensions.geometry)
     order by c.area_km2 nulls last limit 1;
  end if;
  return new;
end $$;
drop trigger if exists venues_set_city on public.venues;
create trigger venues_set_city before insert or update of location, city_id on public.venues
  for each row execute function public.venues_set_city();

-- ---------------------------------------------------------------------------
-- Public RPCs (anon)
-- ---------------------------------------------------------------------------

-- City outlines intersecting the viewport. p_tol = simplification tolerance in degrees.
create or replace function public.cities_in_view(
  w double precision, s double precision, e double precision, n double precision,
  p_tol double precision default 0.0005
)
returns table (
  id text, name text, kind text, status text, phase text, allowed boolean, hot boolean,
  venue_count int, happening_count int, lat double precision, lng double precision, area_km2 numeric, geojson jsonb
)
language sql stable security definer set search_path = '' as $$
  with box as (select extensions.st_makeenvelope(w, s, e, n, 4326) as b)
  select c.id, c.name, c.kind, c.status, c.phase,
         public.city_allowed(c.state, c.center), public.city_is_hot(c.prewarm, c.last_viewed_at),
         c.venue_count,
         coalesce((c.counts->>'happenings')::int, 0),
         extensions.st_y(c.center::extensions.geometry), extensions.st_x(c.center::extensions.geometry),
         c.area_km2,
         extensions.st_asgeojson(extensions.st_simplifypreservetopology(c.geom, greatest(p_tol, 0.00005)), 5)::jsonb
  from public.cities c, box
  where extensions.st_intersects(c.geom, box.b)
  order by c.area_km2 desc nulls last
  limit 400
$$;

create or replace function public.city_status(p_city_id text)
returns table (id text, name text, status text, phase text, allowed boolean, venue_count int, happening_count int,
               last_error text, requested_at timestamptz, refreshed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.status, c.phase, public.city_allowed(c.state, c.center), c.venue_count,
         coalesce((c.counts->>'happenings')::int, 0), case when c.status = 'error' then c.last_error end,
         c.requested_at, c.refreshed_at
  from public.cities c where c.id = p_city_id
$$;

create or replace function public.search_cities(q text, p_limit int default 8)
returns table (id text, name text, kind text, status text, allowed boolean, lat double precision, lng double precision)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.kind, c.status, public.city_allowed(c.state, c.center),
         extensions.st_y(c.center::extensions.geometry), extensions.st_x(c.center::extensions.geometry)
  from public.cities c
  where length(trim(q)) >= 2 and (c.name ilike trim(q) || '%' or extensions.similarity(c.name, trim(q)) > 0.4)
  order by (c.name ilike trim(q) || '%') desc, extensions.similarity(c.name, trim(q)) desc, c.area_km2 desc nulls last
  limit least(greatest(p_limit, 1), 20)
$$;

-- Bump last_viewed_at (throttled to once per 30 min per city) so viewed cities stay fresh.
create or replace function public.mark_city_viewed(p_city_id text)
returns void language sql security definer set search_path = '' as $$
  update public.cities set last_viewed_at = now()
   where id = p_city_id and (last_viewed_at is null or last_viewed_at < now() - interval '30 minutes')
$$;

-- Ask for a city to be loaded. Returns {ok, status, reason?}.
create or replace function public.request_city(p_city_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.cities;
  recent int;
  remaining numeric;
begin
  select * into c from public.cities where id = p_city_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_city'); end if;
  if not public.city_allowed(c.state, c.center) then
    return jsonb_build_object('ok', false, 'status', c.status, 'reason', 'outside_area');
  end if;
  update public.cities set last_viewed_at = now() where id = c.id;
  if c.status in ('queued', 'syncing', 'ready') then
    return jsonb_build_object('ok', true, 'status', c.status);
  end if;
  if c.status = 'error' and c.last_attempt_at > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'status', c.status, 'reason', 'retry_later');
  end if;
  select count(*) into recent from public.cities
   where requested_at > now() - interval '1 hour' and not prewarm;
  if recent >= (public.setting('city_requests_per_hour'))::int then
    return jsonb_build_object('ok', false, 'status', c.status, 'reason', 'busy');
  end if;
  remaining := (public.budget_status() ->> 'remaining_usd')::numeric;
  if remaining < 2 then
    return jsonb_build_object('ok', false, 'status', c.status, 'reason', 'budget');
  end if;
  update public.cities
     set status = 'queued', phase = 'osm', requested_at = now(), attempts = 0, last_error = null
   where id = c.id;
  perform private.invoke_job('city_sync', jsonb_build_object('city_id', c.id));
  return jsonb_build_object('ok', true, 'status', 'queued');
end $$;

revoke all on function public.cities_in_view(double precision, double precision, double precision, double precision, double precision) from public;
revoke all on function public.city_status(text) from public;
revoke all on function public.search_cities(text, int) from public;
revoke all on function public.mark_city_viewed(text) from public;
revoke all on function public.request_city(text) from public;
grant execute on function public.cities_in_view(double precision, double precision, double precision, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.city_status(text) to anon, authenticated, service_role;
grant execute on function public.search_cities(text, int) to anon, authenticated, service_role;
grant execute on function public.mark_city_viewed(text) to anon, authenticated, service_role;
grant execute on function public.request_city(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Service RPCs for the edge functions
-- ---------------------------------------------------------------------------

-- Geometry + bbox for one city (city_sync).
create or replace function public.city_for_sync(p_city_id text)
returns table (id text, name text, state text, status text, phase text, prewarm boolean, attempts int,
               lat double precision, lng double precision, w double precision, s double precision,
               e double precision, n double precision, area_km2 numeric, geojson jsonb)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.state, c.status, c.phase, c.prewarm, c.attempts,
         extensions.st_y(c.center::extensions.geometry), extensions.st_x(c.center::extensions.geometry),
         extensions.st_xmin(c.geom), extensions.st_ymin(c.geom), extensions.st_xmax(c.geom), extensions.st_ymax(c.geom),
         c.area_km2, extensions.st_asgeojson(extensions.st_simplifypreservetopology(c.geom, 0.0002), 6)::jsonb
  from public.cities c where c.id = p_city_id
$$;

-- Next city for city_sync to work on: queued/syncing first (oldest request), then errored ones to
-- retry (<5 attempts, after 15 min), then hot ready cities due for a refresh.
create or replace function public.next_city_for_sync()
returns text language sql stable security definer set search_path = '' as $$
  select id from (
    select id, 0 as pri, coalesce(requested_at, 'epoch') as t from public.cities
     where status in ('queued', 'syncing')
    union all
    select id, 1, last_attempt_at from public.cities
     where status = 'error' and attempts < 5 and coalesce(last_attempt_at, 'epoch') < now() - interval '15 minutes'
    union all
    select id, 2, coalesce(refreshed_at, 'epoch') from public.cities
     where status = 'ready' and public.city_is_hot(prewarm, last_viewed_at)
       and coalesce(refreshed_at, 'epoch') < now() - make_interval(days =>
             case when prewarm then 7 else (public.setting('refresh_days'))::int end)
  ) q order by pri, t limit 1
$$;

-- Recount venues + upcoming/recurring happenings for a city.
create or replace function public.refresh_city_counts(p_city_id text)
returns void language sql security definer set search_path = '' as $$
  update public.cities c set
    venue_count = (select count(*) from public.venues v where v.city_id = c.id and not v.is_hidden),
    counts = c.counts || jsonb_build_object('happenings', (
      select count(*) from public.happenings h join public.venues v on v.id = h.venue_id
       where v.city_id = c.id and not h.is_hidden and not h.is_stale
         and (h.starts_at is null or coalesce(h.ends_at, h.starts_at + interval '3 hours') > now())))
  where c.id = p_city_id
$$;

-- Cities whose events should be pulled (Ticketmaster): ready/syncing and hot.
create or replace function public.active_cities()
returns table (id text, name text, lat double precision, lng double precision, area_km2 numeric,
               w double precision, s double precision, e double precision, n double precision)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, extensions.st_y(c.center::extensions.geometry), extensions.st_x(c.center::extensions.geometry),
         c.area_km2, extensions.st_xmin(c.geom), extensions.st_ymin(c.geom), extensions.st_xmax(c.geom), extensions.st_ymax(c.geom)
  from public.cities c
  where c.status in ('ready', 'syncing') and public.city_is_hot(c.prewarm, c.last_viewed_at)
  order by c.prewarm desc, c.area_km2 desc nulls last
$$;

-- Which allowed city (if any) covers a point. Used to accept events/venues outside New Orleans.
create or replace function public.city_at(p_lat double precision, p_lng double precision)
returns table (id text, name text, allowed boolean)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, public.city_allowed(c.state, c.center) from public.cities c
   where extensions.st_covers(c.geom, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326))
   order by c.area_km2 nulls last limit 1
$$;

-- website_sync queue: never-run first, then oldest; only venues in hot cities (or with no city);
-- over budget -> only prewarm cities. p_city_id restricts to one city.
create or replace function public.website_queue(p_limit int, p_cutoff timestamptz, p_city_id text default null)
returns table (id uuid, url text, venue_id uuid, content_hash text, meta jsonb, venue_name text)
language sql stable security definer set search_path = '' as $$
  with b as (select (public.budget_status() ->> 'remaining_usd')::numeric > 0 as ok)
  select s.id, s.url, s.venue_id, s.content_hash, s.meta, v.name
  from public.sources s
  left join public.venues v on v.id = s.venue_id
  left join public.cities c on c.id = v.city_id
  cross join b
  where s.kind = 'website'
    and (s.last_run_at is null or s.last_run_at < p_cutoff)
    and (p_city_id is null or v.city_id = p_city_id)
    and (c.id is null or public.city_is_hot(c.prewarm, c.last_viewed_at))
    and (b.ok or c.prewarm or c.id is null)
  order by (s.last_run_at is null) desc, (c.requested_at > now() - interval '1 day') desc nulls last, s.last_run_at nulls first
  limit p_limit
$$;

revoke all on function public.city_for_sync(text) from public, anon, authenticated;
revoke all on function public.next_city_for_sync() from public, anon, authenticated;
revoke all on function public.refresh_city_counts(text) from public, anon, authenticated;
revoke all on function public.active_cities() from public, anon, authenticated;
revoke all on function public.city_at(double precision, double precision) from public, anon, authenticated;
revoke all on function public.website_queue(int, timestamptz, text) from public, anon, authenticated;
grant execute on function public.city_for_sync(text) to service_role;
grant execute on function public.next_city_for_sync() to service_role;
grant execute on function public.refresh_city_counts(text) to service_role;
grant execute on function public.active_cities() to service_role;
grant execute on function public.city_at(double precision, double precision) to service_role;
grant execute on function public.website_queue(int, timestamptz, text) to service_role;

-- Upsert one city from a GeoJSON geometry (scripts/cities/load_places.sh). Service role only.
create or replace function public.upsert_city(
  p_id text, p_name text, p_full_name text, p_kind text, p_state text,
  p_lat double precision, p_lng double precision, p_area_km2 numeric, p_geojson jsonb
) returns void language sql security definer set search_path = '' as $$
  insert into public.cities (id, name, full_name, kind, state, geom, center, area_km2)
  values (p_id, p_name, p_full_name, p_kind, p_state,
          extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(extensions.st_setsrid(extensions.st_geomfromgeojson(p_geojson::text), 4326)), 3)),
          extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_area_km2)
  on conflict (id) do update set name = excluded.name, full_name = excluded.full_name, kind = excluded.kind,
    geom = excluded.geom, center = excluded.center, area_km2 = excluded.area_km2
$$;
revoke all on function public.upsert_city(text, text, text, text, text, double precision, double precision, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_city(text, text, text, text, text, double precision, double precision, numeric, jsonb) to service_role;
