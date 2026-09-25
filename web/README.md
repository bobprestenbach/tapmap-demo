# TapMap web (Next.js PWA)

Mobile-first map of what's live right now in New Orleans. Next.js App Router + MapLibre GL
(MapTiler `openstreetmap-dark`, palette-tuned) + Supabase (`happenings_near` RPC, Realtime).

## Run

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000   (/admin for the admin page)
npm run build && npm start   # production (service worker only registers in production)
```

Checks: `npm run lint`, `npm run typecheck`, `npm test` (vitest).

## Environment

| Var | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser | `https://jombmjxzvpskjjxahmul.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | publishable key |
| `NEXT_PUBLIC_MAPTILER_KEY` | browser | restrict by domain in MapTiler |
| `NEXT_PUBLIC_MAPTILER_STYLE` | browser | optional, default `openstreetmap-dark` |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | admin API routes |
| `ADMIN_PASSWORD` | server only | admin login + cookie HMAC secret |

## Notes

- MapLibre v6 loads its worker from a URL; `scripts/copy-maplibre-worker.mjs` (run by `predev`/`prebuild`)
  copies it to `public/maplibre/` (gitignored).
- PWA icons: `npm run icons` regenerates `public/icons/*` and `public/apple-touch-icon.png`.
- Screenshot at 390×844: `npm run build && npm start -- -p 3100 &` then
  `node scripts/screenshot.mjs http://localhost:3100/ out.png` (flags: `--click-first`, `--expand`, `--chip=Bars`;
  `--mock` needs `NEXT_PUBLIC_MOCK_DATA=allow` in a production build).
- `?debug=1` exposes the map as `window.__tmMap` and allows `&style=<maptiler-style>` for comparison.
