# System Specification & Contracts: Personal Media Recommendation Tracker & Archive (IDEA-003, final)

**Status:** Locked by the owner (Charlie) on 2026-11-11. This file supersedes the Gemini v1 and v2 drafts.
**Primary UI:** `https://media.charliechonguyen.com`
**Stack:** Cloudflare Workers Free (TypeScript, ESM, Cron Triggers) + D1 via Drizzle ORM + Hono (`hono/jsx` server-rendered HTML, vanilla JS / HTMX) + Google Docs API v1 (inbox) + Google Sheets API v4 (one-way backup) + Gemini Flash (structured intake, list drafting) + TMDB / OMDb / IGDB / Google Books / iTunes.

## 1. Core Scope & MVP Boundaries

A single-user media tracker and lifetime archive across Movies, TV, Books, Games, Podcasts and One-Offs (videos, articles).

1. **Web app is the only human editing surface.** All status changes, ratings, reviews, filtering and list building run against D1. It sits behind Cloudflare Access (Google sign-in, Charlie only).
2. **One intake pipeline, two doors.** A shared Google Doc (`Media Recommendations Inbox`) and `POST /api/webhook/intake` both call `ingestRawLines(lines, source)`.
3. **Drip enrichment.** Intake writes rows with `enrichment_status = 'PENDING'`. A queue enriches at most 10 items per 15-minute cron tick.
4. **One-way Sheets backup.** A button and a nightly job overwrite a Google Sheet (`Library_Archive`, `Active_Queue`, `Curated_Lists`). The Sheet is never read back.
5. **Curated ranked lists** with optional public read-only pages at `/share/:slug`.

## 2. Strictly Out of Scope ("Do NOT Build")

- No two-way Google Sheets sync, and no reading the Sheet as input.
- No auto-abandon. Only the user sets `Abandoned`.
- No push notifications, emails or alerts. Review nudges live only in the UI.
- No Google Apps Script. No `google-auth-library` or other Node-only SDKs.
- No Tavily, no HowLongToBeat, no Amazon price lookup, no Goodreads, no theatre-chain or showtime data.
- No concerts as a media type.
- No hard delete from the UI. Removal means `status = 'Archived'`.
- No local `wrangler deploy`. Deploys happen only in GitHub Actions on merge to `main`.
- No taste engine or Supabase migration in this plan.

## 3. Non-Negotiable Invariants

1. **Workers Free budget.** At most 50 outbound subrequests and 10 ms CPU per invocation. Every loop over items is capped: intake 25 lines, enrichment 10 items, grooming 15 items, UI tables `LIMIT 100 OFFSET ?`.
2. **Batched writes.** Never `await` a D1 write inside a loop. Coalesce into `db.batch([...])`.
3. **Google auth.** WebCrypto RS256 JWT (`crypto.subtle.sign`), token cached in the D1 `system_kv` table (55-minute TTL). Twitch/IGDB token cached there too (50-day TTL). Signing and token exchange run only on cache miss.
4. **Soft delete only.** `activity_log.item_id` uses `onDelete: 'set null'`. The single exception is the engine's Stage 2 canonical merge, which deletes the newer duplicate row after moving its references.
5. **Never auto-abandon.**
6. **Idempotent intake.** Every line is checked against `intake_log` before Gemini and before any insert or merge.
7. **Optimistic disambiguation with override.** Ambiguous titles resolve to the most recent release; runner-ups go in `alternative_matches_note`. Editing `media_type`, adding a year to the title (`Dune (2021)`), or supplying an external URL/ID resets `enrichment_status = 'PENDING'`.
8. **Access split routing.** `/*` is behind Cloudflare Access. `/share/*` (public, read-only) and `/api/webhook/*` (Bearer token) are Access bypass paths. `workers_dev = false` and `preview_urls = false` so no `*.workers.dev` URL exists.
9. **Public pages leak nothing private.** `/share/:slug` reads only `curated_lists`, `curated_list_items.blurb`, and `title`, `creator`, `release_year`, `poster_image_url`, `my_rating`, `personal_tier`. Never `personal_notes` or `review_text`. Footer carries TMDB and JustWatch attribution.

## 4. Data Model (`src/db/schema.ts`)

Six tables. Timestamps are ISO-8601 UTC strings unless noted.

### 4.1 `media_items`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | `itm_` + 8 hex chars |
| `title` | text not null | |
| `raw_input` | text not null | Original line, or the title for UI-created rows |
| `year_hint` | integer | From intake or a `Title (YYYY)` edit |
| `media_type` | text enum not null | `Movie`, `TV`, `Book`, `Game`, `Podcast`, `One-Off` |
| `status` | text enum not null, default `Backlog` | `Backlog`, `Up Next`, `Active`, `Paused`, `Completed`, `Abandoned`, `Archived` |
| `enrichment_status` | text enum not null, default `PENDING` | `PENDING`, `ENRICHED`, `FAILED`, `SKIPPED` |
| `enrichment_attempts` | integer not null, default 0 | Queue skips rows at 3 |
| `enrichment_error` | text | |
| `tmdb_id`, `imdb_id`, `igdb_id`, `isbn13`, `itunes_id`, `source_url` | text | External identifiers |
| `recommender_name` | text not null, default `Self` | Comma-separated distinct names |
| `recommender_count` | integer not null, default 1 | Count of distinct recommenders |
| `trust_weight` | integer not null, default 3 | 1 to 5. `Justin` is 5 |
| `personal_notes` | text not null, default `''` | |
| `my_rating` | real | 1.0 to 5.0, 0.5 steps |
| `personal_tier` | text enum | `S`, `A`, `B`, `C`, `D` |
| `review_text` | text not null, default `''` | |
| `review_done` | integer boolean not null, default false | |
| `consumed_year` | integer | |
| `completed_at` | text | |
| `creator` | text not null, default `''` | Director, showrunner, author, studio or host |
| `release_year` | integer | |
| `release_date` | text | `YYYY-MM-DD` |
| `release_state` | text enum not null, default `Unknown` | `Upcoming`, `In_Theaters_Limited`, `In_Theaters_Wide`, `Streaming`, `Published`, `Ongoing_TV`, `Ended_TV`, `Unknown` |
| `release_access_display` | text not null, default `Unknown` | |
| `streaming_providers_json` | text not null, default `[]` | |
| `genres_json` | text not null, default `[]` | |
| `is_available_now` | integer boolean not null, default false | |
| `critic_score` | real | Normalised 0 to 100 |
| `critic_score_display` | text not null, default `''` | |
| `time_commitment_display` | text not null, default `''` | |
| `time_commitment_minutes` | integer | |
| `amazon_link` | text not null, default `''` | Books: `https://www.amazon.com/s?k={isbn13 or encoded title}` |
| `poster_image_url` | text not null, default `''` | |
| `alternative_matches_note` | text not null, default `''` | |
| `category_metadata_json` | text not null, default `{}` | |
| `priority_score` | real not null, default 51.0 | |
| `last_status_change_at` | text not null | |
| `last_enriched_at` | text | |
| `created_at`, `updated_at` | text not null | |

Indexes: `status`, `enrichment_status`, `media_type`, `priority_score`, `release_year`, `consumed_year`.

### 4.2 `activity_log`

`id` integer PK autoincrement; `item_id` text FK to `media_items.id` with `onDelete: 'set null'`; `item_title_snapshot` text not null; `media_type` text not null; `event_type` enum (`CREATED`, `STATUS_CHANGE`, `TYPE_OVERRIDE`, `RATING_LOGGED`, `REVIEW_COMPLETED`, `MERGED_RECOMMENDATION`, `CANONICAL_MERGE`); `old_value`, `new_value` text; `day_of_week_pt` integer not null (0 Sunday to 6 Saturday, `America/Los_Angeles`); `hour_of_day_pt` integer not null (0 to 23, `America/Los_Angeles`); `created_at` text not null. Indexes on `item_id` and `created_at`.

### 4.3 `intake_log`

`line_hash` text PK (SHA-256 hex of the line after `trim().toLowerCase()`); `raw_line` text not null; `source` text not null (`gdoc` or `webhook`); `created_at` text not null.

### 4.4 `system_kv`

`key` text PK; `value` text not null; `expires_at` integer not null (Unix seconds).

### 4.5 `curated_lists`

`id` text PK (`lst_` + 6 hex); `slug` text not null, unique index; `title` text not null; `description` text not null default `''`; `media_type_filter` text; `is_public` integer boolean not null default false; `created_at`, `updated_at` text not null.

### 4.6 `curated_list_items`

`id` text PK; `list_id` text not null FK to `curated_lists.id` (`onDelete: 'cascade'`); `media_item_id` text not null FK to `media_items.id` (`onDelete: 'cascade'`); `rank` integer not null; `blurb` text not null default `''`; `created_at` text not null. Index on (`list_id`, `rank`).

### 4.7 Priority score (0 to 100)

- `trustPoints = (trustWeight / 5) * 50` (10 to 50)
- `criticPoints = ((criticScore ?? 70) / 100) * 30` (null scores get 21)
- `multiRecommenderBonus = min(recommenderCount - 1, 2) * 5` (0 to 10)
- `recencyBonus = 10` when `isAvailableNow` and released within the last 365 days, else 0

## 5. Pipelines

### 5.1 Unified intake: `ingestRawLines(lines: string[], source: 'gdoc' | 'webhook')`

1. Take at most 25 non-empty lines. Normalise each (`trim().toLowerCase()`), hash with SHA-256, and drop lines whose hash is already in `intake_log`.
2. Send the surviving lines in one Gemini call with an enforced response schema. Per item: `title`, `yearHint`, `mediaType`, `isAlreadyConsumed`, `recommenderName` (default `Self`; `Justin` gets `trustWeight = 5`), `trustWeight`, `myRating`, `consumedYear`, `personalNotes`, `alternativeMatchesNote`, and the index of its source line. One line may yield several items.
3. **Stage 1 merge.** An item merges into an existing row only when `LOWER(title)` and `media_type` match and the year hint either equals the row's `release_year` or is absent on both. On merge: union recommender names case-insensitively through a `Set`, set `recommender_count` to the number of distinct names, keep `MAX(trust_weight)`, append new notes, log `MERGED_RECOMMENDATION`.
4. Otherwise insert with `status = isAlreadyConsumed ? 'Completed' : 'Backlog'`, `enrichment_status = 'PENDING'`, `review_done = Boolean(myRating || reviewText)`, and log `CREATED`.
5. Write items, activity rows and `intake_log` rows in one `db.batch()`.

**Google Doc door (`*/15 * * * *` cron and the "Sweep Inbox Now" button).** `GET documents/{INBOX_DOC_ID}`. Paragraph 1 is a permanent header (`# Inbox — paste or dictate below`) and is never deleted. Read up to 25 non-empty paragraphs after it, call `ingestRawLines(lines, 'gdoc')`, then `batchUpdate` a `deleteContentRange` from paragraph 2's `startIndex` to the `endIndex` of the last processed paragraph minus 1, with `writeControl: { targetRevisionId }`. On HTTP 400 abort the clear; `intake_log` prevents duplicates next tick. An empty Doc costs one subrequest.

**Webhook door.** `POST /api/webhook/intake` with `Authorization: Bearer <WEBHOOK_SECRET>` and body `{ "text": string, "source"?: string }`. Split `text` on newlines and call `ingestRawLines(lines, 'webhook')`.

### 5.2 Drip enrichment queue

Each 15-minute tick, after the inbox sweep, select up to 10 rows where `enrichment_status = 'PENDING'` and `enrichment_attempts < 3`, oldest first.

- **Movies and TV (TMDB + OMDb).** `/search/movie` or `/search/tv` (prefer the most recent release unless a year hint exists), then details with `append_to_response=release_dates,watch/providers,credits`. Store `tmdb_id`, `imdb_id`, year, genres, director or creator, runtime, poster, US flatrate providers. OMDb by `imdb_id` for Rotten Tomatoes and Metacritic.
- **Movie release state.** US theatrical date (TMDB type 3 wide, type 2 limited) `> today` gives `Upcoming`. Date within the last 60 days and no US flatrate provider gives `In_Theaters_Wide` or `In_Theaters_Limited`. Any flatrate provider gives `Streaming`. Otherwise `Published`. TV uses `Ongoing_TV` or `Ended_TV` from the TMDB status.
- **Games (IGDB only).** `/v4/games` and `/v4/game_time_to_beats`, authenticated with a Twitch client-credentials token.
- **Books (Google Books).** `/volumes?q=intitle:{title}` for author, year, page count, categories, `isbn13`. Build the Amazon search link.
- **Podcasts (iTunes Search).** `media=podcast&entity=podcast` for host, genre, track count, feed URL.
- **One-Offs.** For URLs, fetch OpenGraph or YouTube oEmbed metadata. Plain-text One-Offs are marked `ENRICHED` with whatever is known. Sparse metadata never fails the item.
- **Stage 2 canonical merge.** When an item gains `tmdb_id`, `igdb_id`, `isbn13` or `itunes_id`, look for another row with the same `(media_type, external_id)`. If found: union recommenders, keep `MAX(trust_weight)`, append notes, repoint `activity_log.item_id` and `curated_list_items.media_item_id` to the survivor (the older row), log `CANONICAL_MERGE`, and delete the duplicate, all in one `db.batch()`.
- Recompute `priority_score` after every enrichment or merge. Failures increment `enrichment_attempts` and record `enrichment_error`; the third failure sets `FAILED`.

### 5.3 Mutations and telemetry

REST routes under `/api/items` for create, update, status transitions, rating and review, and soft archive. Every status, type, rating or review change writes an `activity_log` row with Pacific-time day and hour computed through `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Marking `Completed` sets `completed_at` and, when unset, `consumed_year`.

### 5.4 Web UI

- **Now & Next (default).** Active soft slots with Pause and Complete & Rate; Paused items with time since paused; Up Next filterable by media type, streaming service and time commitment, sorted by `priority_score`; Pending Review (`Completed` and `review_done = false`) with inline rating, tier and note.
- **Library tabs** (`Movies`, `TV`, `Books`, `Games`, `Podcasts`, `One-Offs`, `Completed Archive`). Paginated, sortable, filterable tables with inline edits for type, title, status, rating, tier and notes.
- **Lists.** Create and reorder ranked lists, "Draft List with AI" prompt box, share toggle.
- **Header.** Last inbox sync time, pending and failed enrichment counts, "Sweep Inbox Now" and "Backup to Google Sheets" buttons.

### 5.5 Curated lists, AI drafter, public share

CRUD under `/api/lists`. The drafter queries matching `Completed` items and asks Gemini for a ranked list with blurbs; the result is a draft the user saves. `/share/:slug` serves only public lists under invariant 9.

### 5.6 Sheets backup and nightly grooming

- **Backup** (button and nightly). `values.batchClear` on `Library_Archive!A2:Z`, `Active_Queue!A2:Z`, `Curated_Lists!A2:Z`, then one `values.batchUpdate`.
- **Grooming** (`0 10 * * *` UTC, 2:00 AM Pacific standard time). Refresh at most 15 rows: `WHERE release_state IN ('Upcoming','In_Theaters_Limited','In_Theaters_Wide','Ongoing_TV') ORDER BY last_enriched_at ASC NULLS FIRST LIMIT 15`, by stored external ID. At most 30 subrequests.

## 6. Configuration

- **D1:** database `media-recommendation`, id `c1ee16a0-5110-4665-9c4c-a32f3059a853`, binding `DB`.
- **Secrets (Worker):** `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GEMINI_API_KEY`, `TMDB_API_KEY`, `OMDB_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `WEBHOOK_SECRET`.
- **Vars:** `INBOX_DOC_ID`, `BACKUP_SHEET_ID`, `GEMINI_MODEL`.
- **GitHub Actions secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The deploy job skips itself while they are absent.

## 7. Quick checks

`npm run typecheck --silent`, `npm run lint --if-present --silent`, `npm test --silent`.
