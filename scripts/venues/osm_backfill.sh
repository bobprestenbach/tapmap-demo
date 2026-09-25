#!/usr/bin/env bash
# Fetch NOLA bars/restaurants/music venues from Overpass locally and hand them to places_sync
# (useful when the edge runtime's egress IP is rate-limited by Overpass mirrors).
# Usage: CRON_SECRET_FILE=... scripts/venues/osm_backfill.sh ['{"includeNoWebsite":false}']
set -euo pipefail
cd "$(dirname "$0")/../.."
extra="${1:-{\}}"
Q='[out:json][timeout:90];(nwr["amenity"~"^(bar|pub|restaurant|nightclub|biergarten|music_venue)$"]["name"](29.90,-90.15,30.00,-90.015);nwr["live_music"="yes"]["name"](29.90,-90.15,30.00,-90.015););out center tags;'
tmp=$(mktemp)
for m in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter https://maps.mail.ru/osm/tools/overpass/api/interpreter; do
  if curl -sS --fail --max-time 120 -A "TapMapBot/0.1 (New Orleans happenings map)" --data-urlencode "data=$Q" "$m" -o "$tmp"; then break; fi
done
body=$(python3 -c "import json,sys; e=json.load(open(sys.argv[1]))['elements']; b=json.loads(sys.argv[2]); b['elements']=e; print(json.dumps(b))" "$tmp" "$extra")
rm -f "$tmp"
bodyfile=$(mktemp); echo "$body" > "$bodyfile"
secret="${CRON_SECRET:-$(cat "${CRON_SECRET_FILE:?set CRON_SECRET or CRON_SECRET_FILE}")}"
curl -sS -X POST "https://jombmjxzvpskjjxahmul.supabase.co/functions/v1/places_sync" \
  -H "x-cron-secret: $secret" -H "content-type: application/json" --data-binary "@$bodyfile" --max-time 420
rm -f "$bodyfile"; echo
