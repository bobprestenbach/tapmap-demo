#!/usr/bin/env node
// Load Census city outlines (incorporated places + CDPs) for a state into public.cities.
// Source: Census TIGERweb (current vintage), simplified server-side. Idempotent (upsert by GEOID).
//
//   SUPABASE_ACCESS_TOKEN=... node scripts/cities/load_places.mjs [STATE_FIPS=22] [STATE_ABBR=LA]
//
// Uses the Supabase Management API SQL endpoint, so no service-role key is needed locally.
const REF = process.env.SUPABASE_PROJECT_REF ?? "jombmjxzvpskjjxahmul";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const FIPS = process.argv[2] ?? "22";
const ABBR = process.argv[3] ?? "LA";
if (!TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN not set");

const BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";
const LAYERS = [4, 5]; // Incorporated Places, Census Designated Places
const KIND = { "25": "city", "43": "town", "47": "village", "57": "cdp" };

async function layer(id) {
  const q = new URLSearchParams({
    where: `STATE='${FIPS}'`,
    outFields: "GEOID,NAME,BASENAME,LSADC,INTPTLAT,INTPTLON,AREALAND",
    outSR: "4326", maxAllowableOffset: "0.0002", geometryPrecision: "6", f: "geojson",
  });
  const r = await fetch(`${BASE}/${id}/query?${q}`);
  if (!r.ok) throw new Error(`TIGERweb layer ${id}: ${r.status}`);
  const j = await r.json();
  if (j.exceededTransferLimit) throw new Error(`layer ${id} exceeded transfer limit; paginate`);
  return j.features ?? [];
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const lit = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);

const features = [];
for (const id of LAYERS) features.push(...(await layer(id)));
console.log(`fetched ${features.length} places for state ${FIPS}`);

const rows = features.filter((f) => f.geometry && f.properties?.GEOID).map((f) => {
  const p = f.properties;
  return `select public.upsert_city(${lit(p.GEOID)}, ${lit(p.BASENAME)}, ${lit(p.NAME)}, ${lit(KIND[p.LSADC] ?? "city")}, ${lit(ABBR)}, ` +
    `${Number(p.INTPTLAT)}, ${Number(p.INTPTLON)}, ${(Number(p.AREALAND) / 1e6).toFixed(3)}, ${lit(JSON.stringify(f.geometry))}::jsonb);`;
});
for (let i = 0; i < rows.length; i += 40) {
  await sql(rows.slice(i, i + 40).join("\n"));
  process.stdout.write(`\rupserted ${Math.min(i + 40, rows.length)}/${rows.length}`);
}
console.log();
// Attach existing venues to their city (the trigger only fires on insert / location change).
const res = await sql(`update public.venues v set city_id = c.id from public.cities c
  where v.city_id is null and v.location is not null
    and extensions.st_covers(c.geom, v.location::extensions.geometry) returning v.id`);
console.log(`venues attached to a city: ${res.length}`);
