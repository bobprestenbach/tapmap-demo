#!/usr/bin/env bash
# Invoke a sync job: scripts/invoke.sh <function> [json-body]
# Needs CRON_SECRET in env, or CRON_SECRET_FILE pointing at a file holding it.
set -euo pipefail
fn="$1"; body="${2:-{\}}"
secret="${CRON_SECRET:-$(cat "${CRON_SECRET_FILE:?set CRON_SECRET or CRON_SECRET_FILE}")}"
curl -sS -X POST "https://jombmjxzvpskjjxahmul.supabase.co/functions/v1/$fn" \
  -H "x-cron-secret: $secret" -H "content-type: application/json" -d "$body" --max-time 420
echo
