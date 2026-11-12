# Task Progress & Single-Slice Work Lock

> Rule: Mark only ONE task line at a time with `[IN_PROGRESS]`.

<!-- Add slices with /spec or /triage. Format: - [ ] **Slice N** `[GREEN|YELLOW|RED][UI / VISUAL|CORE / DATA]`: goal — Target files: `path`, `path` -->

Plan approved by Charlie on 2026-11-11 (`.spec/SYSTEM_SPEC.md`). The scaffold slice is listed first and runs before the spikes because `main` is red until a `package.json` with quick checks exists.

- [x] **Slice 1: Scaffold and schema** `[YELLOW][CORE / DATA]`: Worker entry with Hono, D1 binding, both cron triggers, Drizzle schema for all six tables, first migration, CI deploy workflow, quick checks | Target files: `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.jsonc`, `drizzle.config.ts`, `vitest.config.ts`, `.gitignore`, `.github/workflows/deploy.yml`, `src/index.ts`, `src/db/schema.ts`, `src/db/schema.test.ts`, `migrations/`
- [x] **Slice 0: Spikes** `[GREEN][CORE / DATA]`: WebCrypto RS256 JWT signing benchmark, CPU benchmark of a 50-line parse and a 300-row serialise, written results | Target files: `spikes/`, `.spec/spikes/`
- [x] **Slice 2: Google and OAuth client** `[YELLOW][CORE / DATA]`: WebCrypto RS256 signer, `system_kv` token cache, Docs and Sheets REST wrapper, unit test | Target files: `src/google/` | Issue: #7
- [x] **Slice 3: Unified intake** `[RED][CORE / DATA]`: `ingestRawLines()`, `intake_log` check, Gemini batch parser (25 lines), Stage 1 merge, `targetRevisionId` Doc clear, `POST /api/webhook/intake`, tests | Target files: `src/intake/`, `src/index.ts` | Issue: #8
- [x] **Slice 4: Enrichment queue, TMDB/OMDb, Stage 2 merge** `[RED][CORE / DATA]`: 10-item queue, TMDB and OMDb adapters, canonical ID merge, priority score, tests | Target files: `src/enrichment/`, `src/index.ts` | Issue: #9
- [x] **Slice 5: Remaining enrichers** `[YELLOW][CORE / DATA]`: IGDB, Google Books with Amazon link, iTunes podcasts, One-Off URL metadata, tests | Target files: `src/enrichment/` | Issue: #10
- [ ] **Slice 6: Core mutations and telemetry API** `[YELLOW][CORE / DATA]`: item CRUD, status, rating and override endpoints, Pacific-time `activity_log` writer, soft archive, tests | Target files: `src/api/`, `src/index.ts`
- [ ] **Slice 7: Web UI, Now & Next dashboard** `[GREEN][UI / VISUAL]`: Hono JSX layout, active soft slots, Up Next filters, inline Pending Review rating, Sweep Inbox Now button | Target files: `src/ui/`, `src/index.ts`
- [ ] **Slice 8: Web UI, category tables and archive** `[GREEN][UI / VISUAL]`: paginated, filterable library and completed archive tables, inline title and type override | Target files: `src/ui/`
- [ ] **Slice 9: Curated lists CRUD and AI list drafter** `[YELLOW][CORE / DATA]`: lists API, Gemini list-drafting endpoint, tests | Target files: `src/lists/`, `src/index.ts`
- [ ] **Slice 10: Public share boundary and Lists UI** `[RED][CORE / DATA]`: `/share/:slug` with strict column allowlist and attribution footer, Lists management UI, security test | Target files: `src/share/`, `src/ui/`, `src/index.ts`
- [ ] **Slice 11: Sheets backup and nightly grooming** `[YELLOW][CORE / DATA]`: `batchClear` then `batchUpdate` exporter, 15-item grooming cron, tests | Target files: `src/backup/`, `src/grooming/`, `src/index.ts`
