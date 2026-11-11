# Architecture Decision Records (ADRs)

- 2026-11-11: The web app on D1 is the only editing surface; Google Sheets is a one-way backup. Why: two-way Sheet diffing cannot survive sorts, deletes or mid-run edits.
- 2026-11-11: Stay on Workers Free. Every per-item loop is capped (intake 25, enrichment 10, grooming 15). Why: 50 outbound subrequests and 10 ms CPU per invocation.
- 2026-11-11: Intake idempotency lives in an `intake_log` table keyed by a SHA-256 of the normalised line, checked before Gemini and before insert or merge. Why: a hash on `media_items` cannot guard the merge path or lines that yield several items.
- 2026-11-11: Duplicates merge in two stages: title, type and year hint at intake; external ID after enrichment. Why: the canonical title does not exist at intake.
- 2026-11-11: Google Doc sweep and `POST /api/webhook/intake` share `ingestRawLines()`. Why: Gemini Web and Claude Web write to the Doc; iOS Shortcuts and Meta Muse post to the webhook.
- 2026-11-11: Google and Twitch tokens are cached in a D1 `system_kv` table. Why: Worker memory does not persist and signing costs CPU.
- 2026-11-11: IGDB is the only games source. Tavily and HowLongToBeat are dropped. Why: structured, deterministic data.
- 2026-11-11: The Doc clear uses `targetRevisionId` and keeps paragraph 1 as a header. Why: newer text survives a concurrent edit.
- 2026-11-11: UI is Hono with `hono/jsx` server-rendered HTML plus vanilla JS or HTMX. Why: no frontend build pipeline.
- 2026-11-11: `workers_dev = false` and `preview_urls = false`. Why: a `*.workers.dev` URL would bypass Cloudflare Access.
- 2026-11-11: Public share pages read from a strict column allowlist. Why: `personal_notes` and `review_text` must never leak.
- 2026-11-11: Slice 1 runs before Slice 0. Why: `main` carries the `harness-main-red` tag until a `package.json` with passing quick checks lands.
- 2026-11-11: Added `year_hint` to `media_items` and `CANONICAL_MERGE` to the activity event enum. Why: Stage 1 merge compares year hints, and Stage 2 merges need their own audit event.
