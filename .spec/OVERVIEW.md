# Project Overview (Owner's Manual)

## What This App Does
- A personal tracker and lifetime archive for movies, TV, books, games, podcasts and one-off videos or articles. You drop messy recommendations into one Google Doc (or send them from a phone shortcut). Every 15 minutes the app reads them, works out what each one is, and fills in release, streaming, length and review-score details a few items at a time. You manage everything at `media.charliechonguyen.com`: what you are on now, what is next, what you finished and how you rated it. You can build ranked lists and share them with a public link. A Google Sheet copy is refreshed nightly as a backup.

## Current Build Status
- **Built and merged (code complete, not yet deployed):** all twelve slices in `.spec/PROGRESS.md` (scaffold and schema, spikes, Google client, unified intake, enrichment queue and all enrichers, mutations API, Now & Next dashboard, library tables and archive, curated lists and AI drafter, public share page, Sheets backup and nightly grooming).
- **Live & Verified:** none yet. The deploy workflow skips itself until the Cloudflare secrets exist.
- **In Progress:** none.
- **Up Next:** the owner's setup steps (Cloudflare and Google secrets, Access app, Doc and Sheet ids), then a first deploy and a real CPU-time check.
