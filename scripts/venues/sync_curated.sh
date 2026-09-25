#!/usr/bin/env bash
# Upsert data/venues/curated.json through places_sync (provider=curated). Matches existing
# rows by name + <150 m and enriches them (category/website from the curated file win).
# Usage: CRON_SECRET_FILE=... scripts/venues/sync_curated.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
bodyfile=$(mktemp)
python3 -c "import json; d=json.load(open('data/venues/curated.json')); print(json.dumps({'provider':'curated','venues':d['venues']}))" > "$bodyfile"
secret="${CRON_SECRET:-$(cat "${CRON_SECRET_FILE:?set CRON_SECRET or CRON_SECRET_FILE}")}"
curl -sS -X POST "https://jombmjxzvpskjjxahmul.supabase.co/functions/v1/places_sync" \
  -H "x-cron-secret: $secret" -H "content-type: application/json" --data-binary "@$bodyfile" --max-time 300
rm -f "$bodyfile"; echo
