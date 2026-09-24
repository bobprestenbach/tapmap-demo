#!/usr/bin/env bash
# Deploy one or more edge functions without Docker. Requires SUPABASE_ACCESS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
for fn in "$@"; do
  npx -y supabase@latest functions deploy "$fn" --project-ref jombmjxzvpskjjxahmul --use-api --no-verify-jwt
done
