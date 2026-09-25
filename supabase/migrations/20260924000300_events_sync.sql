-- events_sync support: venue resolution cache + a compact venue index for in-memory matching.

-- Maps an external venue key to a TapMap venue (and caches geocoding), e.g.
--   'tm:<ticketmaster venue id>'   -> venue created/matched for a Ticketmaster venue
--   'wwoz:<organization slug>'     -> WWOZ Livewire venue, with address scraped from its org page
--                                     and geocoded via Nominatim
create table if not exists public.event_venue_cache (
  key text primary key,
  name text not null,
  address text,
  website text,
  lat double precision,
  lng double precision,
  venue_id uuid references public.venues(id) on delete set null,
  status text not null default 'pending',   -- resolved | not_found | outside | pending
  attempts int not null default 0,
  meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.event_venue_cache enable row level security;  -- service role only (no policies)

-- Compact list of venues with lat/lng for fuzzy matching in the edge function.
create or replace function public.events_venue_index()
returns table (id uuid, name text, category text, data_source text, lat double precision, lng double precision, address text)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.name, v.category, v.data_source,
         extensions.st_y(v.location::extensions.geometry),
         extensions.st_x(v.location::extensions.geometry),
         v.address
  from public.venues v
  where v.location is not null
$$;
revoke all on function public.events_venue_index() from public, anon, authenticated;
grant execute on function public.events_venue_index() to service_role;
