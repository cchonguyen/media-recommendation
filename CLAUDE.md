# Project Context & Harness Dispatcher

@.claude/harness-rules.md
@.claude/project-rules.md

## Project
- Personal Media Recommendation Tracker & Archive (IDEA-003). Full contract: `.spec/SYSTEM_SPEC.md`.
- Stack: Cloudflare Workers Free (TypeScript, ESM, cron), D1 via Drizzle ORM, Hono with `hono/jsx`, Google Docs and Sheets REST, Gemini Flash, TMDB, OMDb, IGDB, Google Books, iTunes.
- Deploys run only in GitHub Actions on merge to `main` (`.github/workflows/deploy.yml`). Never run `wrangler deploy` locally.

## Work Mode
- Default is **Manager Mode** (`"workMode": "manager"` in `.spec/harness.json`): no `[IN_PROGRESS]` slice means no edits outside `.spec/` until a task is planned. Small one-file tweaks use `/quick-fix` (added in a later slice).
- `"workMode": "vibe"` turns the plan lock off for this project.
- One `[IN_PROGRESS]` line = **Slice Mode**: strict single-task lock on that slice's target files.

## Project-Specific Commands
- Typecheck: `npm run typecheck --silent`
- Unit tests: `npm test --silent`
- Lint: `npm run lint --if-present --silent`
- New migration after a schema change: `npm run db:generate`
