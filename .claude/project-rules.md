# Project Rules

This file is owned by this project. The harness never overwrites it.

## Active Project Rules
- Workers Free budget: at most 50 outbound subrequests and 10 ms CPU per invocation. Cap every per-item loop (intake 25 lines, enrichment 10 items, grooming 15 items, UI tables `LIMIT 100`).
- Never `await` a D1 write inside a loop. Coalesce writes into `db.batch([...])`.
- No Node-only SDKs. Google auth is a WebCrypto RS256 JWT with the token cached in `system_kv`.
- Soft delete only: the UI sets `status = 'Archived'`. Never auto-set `Abandoned`.
- Every intake line is checked against `intake_log` before Gemini and before any insert or merge.
- `/share/:slug` reads only the public column allowlist in `.spec/SYSTEM_SPEC.md` section 3, invariant 9.
- Tests never call live external APIs. Inject `fetch` and stub it.
- Standing approval (Charlie, 2026-11-11): commits and merges for the slices in `.spec/PROGRESS.md` proceed without further confirmation once checks are green. Questions for the owner are banked until the last slice.
- Standing approval (Charlie, 2026-11-24): whenever code changes are verified and ready to report "done", commit them on a branch, push, open a PR against main, wait for required checks to pass, merge into main (to trigger the GitHub Actions deploy; never deploy locally), delete the branch, and fast-forward local main before reporting done.

## Pending Rule Candidates — not in force
