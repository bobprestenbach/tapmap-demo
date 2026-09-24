-- Map category shown in the app for a happening (drives marker color + filter chips).
create or replace function public.happening_category(p_kind text, p_venue_category text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'live_music' then 'music_venue'
    when p_kind = 'truck_stop' then 'food_truck'
    when p_kind = 'popup' then 'popup'
    when p_kind = 'event' then coalesce(p_venue_category, 'popup')
    else coalesce(p_venue_category, 'restaurant')
  end
$$;

-- Concrete occurrences of every visible happening around a moment in time.
-- One-offs use starts_at/ends_at (ends_at null => +3h).
-- Recurring rows are expanded for the local (America/Chicago) dates yesterday/today/tomorrow,
-- so overnight windows and "starting soon after midnight" both work, and DST is handled by
-- converting local wall-clock timestamps with AT TIME ZONE.
create or replace function public.happening_occurrences(p_at timestamptz)
returns table (happening_id uuid, occ_start timestamptz, occ_end timestamptz)
language sql stable set search_path = '' as $$
  with d as (
    select ((p_at at time zone 'America/Chicago')::date + g) as day
    from generate_series(-1, 1) g
  )
  select h.id, h.starts_at, coalesce(h.ends_at, h.starts_at + interval '3 hours')
  from public.happenings h
  where h.starts_at is not null
  union all
  select h.id, x.s,
    case
      when h.end_time is null then x.s + interval '3 hours'
      else ((d.day + h.end_time
             + case when h.end_time <= h.start_time then interval '1 day' else interval '0' end)
            at time zone 'America/Chicago')
    end
  from public.happenings h
  cross join d
  cross join lateral (select ((d.day + h.start_time) at time zone 'America/Chicago') as s) x
  where h.starts_at is null
    and extract(dow from d.day)::int = any (h.days_of_week)
$$;

-- Live-now + starting-within-window happenings near a point.
create or replace function public.happenings_near(
  lat double precision,
  lng double precision,
  radius_m double precision default 8000,
  at timestamptz default now(),
  categories text[] default null,
  upcoming_window interval default interval '2 hours'
)
returns table (
  id uuid,
  venue_id uuid,
  venue_name text,
  category text,
  kind text,
  title text,
  description text,
  price_text text,
  lat double precision,
  lng double precision,
  distance_m double precision,
  occ_start timestamptz,
  occ_end timestamptz,
  is_live boolean,
  address text,
  neighborhood text,
  website text,
  source_url text,
  last_verified_at timestamptz,
  confidence real,
  location_name text
)
language sql stable security invoker set search_path = '' as $$
  with me as (
    select extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography as g
  ),
  occ as (
    select distinct on (o.happening_id) o.happening_id, o.occ_start, o.occ_end
    from public.happening_occurrences(at) o
    where o.occ_end > at and o.occ_start <= at + upcoming_window
    order by o.happening_id, (o.occ_start > at), o.occ_start
  )
  select
    h.id, h.venue_id,
    coalesce(v.name, h.location_name) as venue_name,
    public.happening_category(h.kind, v.category) as category,
    h.kind, h.title, h.description, h.price_text,
    extensions.st_y(coalesce(h.location, v.location)::extensions.geometry) as lat,
    extensions.st_x(coalesce(h.location, v.location)::extensions.geometry) as lng,
    extensions.st_distance(coalesce(h.location, v.location), me.g) as distance_m,
    occ.occ_start, occ.occ_end,
    (occ.occ_start <= at) as is_live,
    v.address, v.neighborhood, v.website,
    h.source_url, h.last_verified_at, h.confidence,
    h.location_name
  from occ
  join public.happenings h on h.id = occ.happening_id
  left join public.venues v on v.id = h.venue_id
  cross join me
  where not h.is_hidden
    and not h.is_stale
    and (v.id is null or not v.is_hidden)
    and coalesce(h.location, v.location) is not null
    and extensions.st_dwithin(coalesce(h.location, v.location), me.g, radius_m)
    and (categories is null or cardinality(categories) = 0
         or public.happening_category(h.kind, v.category) = any (categories))
  order by (occ.occ_start <= at) desc, distance_m
  limit 500
$$;

-- Public "Report wrong info" (the only anon write path).
create or replace function public.report_wrong_info(p_happening_id uuid, p_reason text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.reports (happening_id, venue_id, reason)
  select h.id, h.venue_id, left(p_reason, 500)
  from public.happenings h where h.id = p_happening_id and not h.is_hidden
$$;

revoke all on function public.happening_occurrences(timestamptz) from public;
grant execute on function public.happening_occurrences(timestamptz) to anon, authenticated, service_role;
grant execute on function public.happenings_near(double precision, double precision, double precision, timestamptz, text[], interval) to anon, authenticated, service_role;
grant execute on function public.happening_category(text, text) to anon, authenticated, service_role;
revoke all on function public.report_wrong_info(uuid, text) from public;
grant execute on function public.report_wrong_info(uuid, text) to anon, authenticated;
