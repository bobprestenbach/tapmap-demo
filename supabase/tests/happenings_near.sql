-- RPC regression test. Run inside a transaction (it rolls back):
--   psql / Supabase SQL editor / MCP execute_sql. Every row must have pass = true.
begin;
insert into venues(id,name,category,location) values
 ('00000000-0000-0000-0000-0000000000a1','Test Bar','bar','SRID=4326;POINT(-90.0715 29.9511)');
insert into happenings(venue_id,kind,title,days_of_week,start_time,end_time) values
 ('00000000-0000-0000-0000-0000000000a1','happy_hour','T-HH',array[1,2,3,4,5],'16:00','19:00'),
 ('00000000-0000-0000-0000-0000000000a1','live_music','T-Late',array[5],'22:00','02:00');
insert into happenings(venue_id,kind,title,starts_at,ends_at) values
 ('00000000-0000-0000-0000-0000000000a1','event','T-Oneoff','2026-09-24 20:00-05','2026-09-24 23:00-05');
with cases(label, at, cats, expect_title, expect_live) as (values
  ('weekday happy hour live (CDT)', timestamptz '2026-09-24 17:00-05', null::text[], 'T-HH', true),
  ('happy hour upcoming within 2h', timestamptz '2026-09-24 14:30-05', null, 'T-HH', false),
  ('nothing at 13:00', timestamptz '2026-09-24 13:00-05', null, null, null),
  ('overnight set live after midnight', timestamptz '2026-09-26 01:30-05', null, 'T-Late', true),
  ('happy hour live in winter (CST)', timestamptz '2027-01-07 17:00-06', null, 'T-HH', true),
  ('category filter', timestamptz '2026-09-25 21:00-05', array['music_venue'], 'T-Late', false),
  ('one-off live', timestamptz '2026-09-24 21:00-05', array['bar'], 'T-Oneoff', true),
  ('saturday no happy hour', timestamptz '2026-09-26 17:00-05', null, null, null)
)
select c.label,
  case when c.expect_title is null
       then not exists (select 1 from happenings_near(29.9511,-90.0715,1000,c.at,c.cats) r where r.title like 'T-%')
       else exists (select 1 from happenings_near(29.9511,-90.0715,1000,c.at,c.cats) r
                    where r.title = c.expect_title and r.is_live = c.expect_live) end as pass
from cases c;
rollback;
