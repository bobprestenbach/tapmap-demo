-- TapMap core schema: venues, happenings, sources, raw_pages, sync_runs, reports.
create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- venues
-- ---------------------------------------------------------------------------
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  google_place_id text unique,
  osm_id text unique,                -- e.g. 'node/123' / 'way/456'
  name text not null,
  category text not null check (category in ('restaurant','bar','food_truck','music_venue','popup')),
  location extensions.geography(Point, 4326),
  address text,
  neighborhood text,
  website text,
  instagram text,
  phone text,
  price_level int,
  rating numeric(2,1),
  opening_hours jsonb,
  photo_ref text,
  data_source text not null default 'curated',  -- google | osm | curated | ticketmaster | wwoz
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index venues_location_idx on public.venues using gist (location);
create index venues_name_trgm_idx on public.venues using gin (name extensions.gin_trgm_ops);
create index venues_category_idx on public.venues (category);

-- ---------------------------------------------------------------------------
-- sources: every URL / API feed we pull from
-- ---------------------------------------------------------------------------
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null,               -- website | ticketmaster | wwoz | truck_site | seatgeek | instagram | google_places | osm
  url text not null,
  venue_id uuid references public.venues(id) on delete cascade,
  cadence text,                     -- weekly | daily | 6h | 30m
  last_run_at timestamptz,
  last_status text,
  content_hash text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (kind, url)
);
create index sources_venue_idx on public.sources (venue_id);
create index sources_kind_last_run_idx on public.sources (kind, last_run_at nulls first);

-- ---------------------------------------------------------------------------
-- happenings: what is going on (one-off OR weekly recurrence)
-- days_of_week: 0 = Sunday .. 6 = Saturday; times are America/Chicago wall-clock.
-- end_time <= start_time means the window crosses midnight.
-- ---------------------------------------------------------------------------
create table public.happenings (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete cascade,
  kind text not null check (kind in ('happy_hour','special','live_music','event','truck_stop','popup')),
  title text not null,
  description text,
  price_text text,
  starts_at timestamptz,
  ends_at timestamptz,
  days_of_week int[],
  start_time time,
  end_time time,
  location extensions.geography(Point, 4326),   -- override (trucks, unmatched events)
  location_name text,
  source_id uuid references public.sources(id) on delete set null,
  source_url text,
  external_id text unique,           -- stable dedupe key, e.g. 'tm:G5v...', 'wwoz:...', 'web:<venue>:<hash>'
  confidence real not null default 0.5 check (confidence between 0 and 1),
  last_verified_at timestamptz not null default now(),
  is_stale boolean not null default false,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint happenings_has_schedule check (
    starts_at is not null
    or (days_of_week is not null and cardinality(days_of_week) > 0 and start_time is not null)
  ),
  constraint happenings_has_place check (venue_id is not null or location is not null)
);
create index happenings_venue_idx on public.happenings (venue_id);
create index happenings_starts_idx on public.happenings (starts_at);
create index happenings_location_idx on public.happenings using gist (location);
create index happenings_kind_idx on public.happenings (kind);

-- ---------------------------------------------------------------------------
-- raw_pages: fetched text kept for reprocessing
-- ---------------------------------------------------------------------------
create table public.raw_pages (
  id bigint generated always as identity primary key,
  source_id uuid references public.sources(id) on delete cascade,
  url text not null,
  fetched_at timestamptz not null default now(),
  content_hash text not null,
  text text
);
create index raw_pages_source_idx on public.raw_pages (source_id, fetched_at desc);

-- ---------------------------------------------------------------------------
-- sync_runs: job audit log
-- ---------------------------------------------------------------------------
create table public.sync_runs (
  id bigint generated always as identity primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  counts jsonb not null default '{}'::jsonb,
  error text
);
create index sync_runs_job_idx on public.sync_runs (job, started_at desc);

-- ---------------------------------------------------------------------------
-- reports: "Report wrong info" from the public app
-- ---------------------------------------------------------------------------
create table public.reports (
  id bigint generated always as identity primary key,
  happening_id uuid references public.happenings(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  resolved boolean not null default false
);

-- updated_at triggers
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger venues_touch before update on public.venues
  for each row execute function public.touch_updated_at();
create trigger happenings_touch before update on public.happenings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: public read of visible rows; writes only via service role
-- ---------------------------------------------------------------------------
alter table public.venues enable row level security;
alter table public.happenings enable row level security;
alter table public.sources enable row level security;
alter table public.raw_pages enable row level security;
alter table public.sync_runs enable row level security;
alter table public.reports enable row level security;

create policy "public read visible venues" on public.venues
  for select to anon, authenticated using (not is_hidden);
create policy "public read visible happenings" on public.happenings
  for select to anon, authenticated using (not is_hidden);

-- Realtime for new pins
alter publication supabase_realtime add table public.happenings;
