-- Venue import helper: lightweight venue list with lat/lng for name+distance matching
-- (places_sync). Service-role only.
create or replace function public.venues_for_match()
returns table (
  id uuid, name text, category text, osm_id text, google_place_id text,
  data_source text, website text, lat double precision, lng double precision
)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.name, v.category, v.osm_id, v.google_place_id, v.data_source, v.website,
         extensions.st_y(v.location::extensions.geometry),
         extensions.st_x(v.location::extensions.geometry)
  from public.venues v
$$;
revoke all on function public.venues_for_match() from public, anon, authenticated;
grant execute on function public.venues_for_match() to service_role;
