#!/bin/bash
# SessionStart hook for Claude Code on the web: install web app deps and warm the
# Deno + Supabase CLI caches so lint/typecheck/tests and edge-function checks work.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# Next.js PWA (web/)
if [ -f web/package.json ]; then
  (cd web && npm install --no-audit --no-fund)
fi

# Edge functions are Deno; the Supabase CLI deploys them. Both run via npx.
npx -y deno --version >/dev/null
npx -y supabase@latest --version >/dev/null
