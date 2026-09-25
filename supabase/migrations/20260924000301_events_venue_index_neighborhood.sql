-- events_sync: include neighborhood in the venue index (used to label venues events_sync creates).
drop function if exists public.events_venue_index();
create function public.events_venue_index()
returns table (id uuid, name text, category text, data_source text, lat double precision, lng double precision,
               address text, neighborhood text)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.name, v.category, v.data_source,
         extensions.st_y(v.location::extensions.geometry),
         extensions.st_x(v.location::extensions.geometry),
         v.address, v.neighborhood
  from public.venues v
  where v.location is not null
$$;
revoke all on function public.events_venue_index() from public, anon, authenticated;
grant execute on function public.events_venue_index() to service_role;
