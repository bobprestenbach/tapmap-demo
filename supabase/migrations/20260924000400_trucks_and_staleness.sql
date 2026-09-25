-- Food trucks / pop-ups (trucks_sync) + nightly staleness (expire_stale).

-- Geocoding cache for truck stop locations (address or place-name query -> point).
-- status: ok | not_found. Service role only.
create table if not exists public.truck_geocode_cache (
  query text primary key,            -- normalised lower-case query string
  lat double precision,
  lng double precision,
  provider text,                     -- census | nominatim | host
  status text not null default 'ok',
  created_at timestamptz not null default now()
);
alter table public.truck_geocode_cache enable row level security;  -- no policies => service role only

-- Nightly staleness pass. Returns counts as jsonb.
--  * recurring happenings (starts_at null) not re-verified in 14 days -> is_stale = true
--  * recurring happenings re-verified within 14 days that were stale   -> is_stale = false
--  * one-offs that ended more than 2 days ago                          -> is_stale = true
--  * raw_pages older than 30 days are deleted, except the latest row per source
create or replace function public.expire_stale_run(
  p_recurring_days int default 14,
  p_oneoff_grace_days int default 2,
  p_raw_days int default 30
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  n_stale int; n_fresh int; n_oneoff int; n_raw int;
begin
  update public.happenings set is_stale = true
   where starts_at is null and not is_stale
     and last_verified_at < now() - make_interval(days => p_recurring_days);
  get diagnostics n_stale = row_count;

  update public.happenings set is_stale = false
   where starts_at is null and is_stale
     and last_verified_at >= now() - make_interval(days => p_recurring_days);
  get diagnostics n_fresh = row_count;

  update public.happenings set is_stale = true
   where starts_at is not null and not is_stale
     and coalesce(ends_at, starts_at + interval '3 hours') < now() - make_interval(days => p_oneoff_grace_days);
  get diagnostics n_oneoff = row_count;

  delete from public.raw_pages r
   where r.fetched_at < now() - make_interval(days => p_raw_days)
     and r.id <> (select max(r2.id) from public.raw_pages r2
                   where r2.source_id is not distinct from r.source_id and r2.url = r.url);
  get diagnostics n_raw = row_count;

  return jsonb_build_object(
    'recurring_marked_stale', n_stale,
    'recurring_unstaled', n_fresh,
    'oneoffs_expired', n_oneoff,
    'raw_pages_deleted', n_raw,
    'recurring_stale_total', (select count(*) from public.happenings where starts_at is null and is_stale),
    'recurring_live_total', (select count(*) from public.happenings where starts_at is null and not is_stale)
  );
end $$;
revoke all on function public.expire_stale_run(int, int, int) from public, anon, authenticated;
grant execute on function public.expire_stale_run(int, int, int) to service_role;
