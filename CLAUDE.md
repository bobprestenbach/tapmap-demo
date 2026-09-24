# TapMap

Free mobile-first map of what's happening right now at New Orleans hospitality businesses
(bars, restaurants, food trucks, live music, pop-ups, happy hours), auto-populated from public data.

**Start here:** `docs/BUILD_PLAN.md` is the full MVP brief (scope, stack, credentials, data model,
workstreams, definition of done). When the owner says "Start the TapMap build", execute that plan
end to end on autopilot using parallel sub-agents.

**UI must match `docs/design/reference.webp`** — view the image before any frontend work.

- Supabase project: `tapmap-demo` (ref `jombmjxzvpskjjxahmul`). Never modify `ochdiylnsiiszxprwqdj`.
- Timezone for all "live now" logic: America/Chicago.
- Never commit secrets; keys come from environment variables listed in the plan.
- Log progress, skipped items, and known gaps in `docs/BUILD_LOG.md`.
