-- Prewarm list (kept fresh regardless of views) + mark New Orleans ready (its venues pre-date city loading).
-- Requires public.cities to be loaded first: node scripts/cities/load_places.mjs 22 LA
update public.cities set status = 'ready', phase = 'done', synced_at = coalesce(synced_at, now()),
       refreshed_at = coalesce(refreshed_at, now())
 where id = '2255000' and status = 'none';
update public.cities set prewarm = true
 where state = 'LA' and name in ('New Orleans','Metairie','Kenner','Baton Rouge','Lafayette','Lake Charles',
                                 'Slidell','Mandeville','Covington','Hammond','Houma');
