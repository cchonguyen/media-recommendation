import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { createSubrequestBudget } from "../google/api";
import type { SubrequestBudget } from "../google/api";
import type { Db } from "../google/token";
import { mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { MERGE_COLUMNS, pickColumns, planCanonicalMerges, priorityForRow } from "./merge";
import type { BatchItem, WorkingRow } from "./merge";
import { fetchOmdbRatings } from "./omdb";
import { fetchTmdbMetadata } from "./tmdb";
import { igdbEnricher } from "./igdb";
import { booksEnricher } from "./books";
import { itunesEnricher } from "./itunes";
import { oneOffEnricher } from "./oneoff";
import { ENRICH_COLUMNS } from "./types";
import type { EnrichContext, EnrichOutcome, EnrichedFields, Enricher, EnrichmentEnv } from "./types";

export const MAX_ITEMS_PER_RUN = 10;
export const MAX_ATTEMPTS = 3;

const tmdbEnricher = (mediaType: "Movie" | "TV"): Enricher => ({
  subrequestsNeeded: (env) => 2 + (env.OMDB_API_KEY ? 1 : 0),
  hasCredentials: (env) => Boolean(env.TMDB_API_KEY),
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const tmdb = await fetchTmdbMetadata({
      mediaType,
      title: ctx.row.title,
      yearHint: ctx.row.yearHint,
      apiKey: ctx.env.TMDB_API_KEY!,
      fetchImpl: ctx.fetchImpl,
      budget: ctx.budget,
      now: ctx.now,
    });
    if (tmdb.kind === "not-found") return tmdb;
    const fields: EnrichedFields = { ...tmdb.fields };
    // OMDb is optional: any failure leaves the critic score null.
    if (fields.imdbId) {
      const r = await fetchOmdbRatings({
        imdbId: fields.imdbId,
        apiKey: ctx.env.OMDB_API_KEY,
        fetchImpl: ctx.fetchImpl,
        budget: ctx.budget,
      });
      fields.criticScore = r.criticScore;
      fields.criticScoreDisplay = r.criticScoreDisplay;
    }
    return { kind: "ok", fields };
  },
});

/** Registration point for every media type. */
const registry = new Map<MediaItem["mediaType"], Enricher>();
export function registerEnricher(type: MediaItem["mediaType"], enricher: Enricher): void {
  registry.set(type, enricher);
}
registerEnricher("Movie", tmdbEnricher("Movie"));
registerEnricher("TV", tmdbEnricher("TV"));
registerEnricher("Game", igdbEnricher);
registerEnricher("Book", booksEnricher);
registerEnricher("Podcast", itunesEnricher);
registerEnricher("One-Off", oneOffEnricher);

export interface EnrichmentSummary {
  processed: number;
  enriched: number;
  failed: number;
  merged: number;
  skipped?: "no-tmdb-key" | "budget";
}

export interface EnrichmentDeps {
  db: Db;
  env: EnrichmentEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now?: () => Date;
  /** Test override. Defaults to the shared registry. */
  enrichers?: ReadonlyMap<MediaItem["mediaType"], Enricher>;
}

function safeMessage(e: unknown, env: EnrichmentEnv): string {
  let msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  for (const secret of [env.TMDB_API_KEY, env.OMDB_API_KEY, env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET, env.GOOGLE_BOOKS_API_KEY]) {
    if (secret) msg = msg.split(secret).join("[redacted]");
  }
  return msg.slice(0, 200);
}

export async function runEnrichmentQueue(deps: EnrichmentDeps): Promise<EnrichmentSummary> {
  const { db, env } = deps;
  const registered = deps.enrichers ?? registry;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const budget = deps.budget ?? createSubrequestBudget(50);
  const summary: EnrichmentSummary = { processed: 0, enriched: 0, failed: 0, merged: 0 };

  // Types whose enricher lacks credentials wait, and no attempts are burned. Excluding them from the
  // query keeps them from taking the 10 queue slots.
  const types = [...registered.entries()].filter(([, e]) => e.hasCredentials(env)).map(([t]) => t);
  if (types.length === 0) return { ...summary, skipped: "no-tmdb-key" };

  const rows = await db
    .select()
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.enrichmentStatus, "PENDING"),
        lt(mediaItems.enrichmentAttempts, MAX_ATTEMPTS),
        inArray(mediaItems.mediaType, types),
      ),
    )
    .orderBy(asc(mediaItems.createdAt), asc(mediaItems.id))
    .limit(MAX_ITEMS_PER_RUN);

  const stmts: BatchItem[] = [];
  const working = new Map<string, WorkingRow>();
  const deleted = new Set<string>();
  const failures: { row: MediaItem; message: string }[] = [];

  for (const row of rows) {
    // An earlier item in this run already merged this row or made it a survivor.
    if (deleted.has(row.id) || working.has(row.id)) continue;
    const enricher = registered.get(row.mediaType)!;
    if (!enricher.hasCredentials(env)) continue;
    if (budget.limit - budget.used < enricher.subrequestsNeeded(env)) {
      summary.skipped = "budget";
      break;
    }
    summary.processed++;
    let outcome: EnrichOutcome;
    try {
      outcome = await enricher.enrich({ db, row, env, fetchImpl: deps.fetchImpl, budget, now });
    } catch (e) {
      failures.push({ row, message: safeMessage(e, env) });
      continue;
    }
    if (outcome.kind === "not-found") {
      failures.push({ row, message: "No match found" });
      continue;
    }
    const enrichedRow: MediaItem = {
      ...row,
      ...outcome.fields,
      enrichmentStatus: "ENRICHED",
      enrichmentError: null,
      lastEnrichedAt: nowIso,
      updatedAt: nowIso,
    };
    enrichedRow.priorityScore = priorityForRow(enrichedRow, now);
    working.set(row.id, { row: enrichedRow, enriched: true, merged: false });
    summary.enriched++;
    // Reads only: the merge statements are queued, not run.
    const plan = await planCanonicalMerges({ db, targetId: row.id, working, deleted, now, out: stmts });
    summary.merged += plan.merges;
  }

  if (summary.processed === 0 && !summary.skipped && !env.TMDB_API_KEY) summary.skipped = "no-tmdb-key";

  for (const w of working.values()) {
    const set = {
      ...pickColumns(w.row, ENRICH_COLUMNS),
      ...(w.merged ? pickColumns(w.row, MERGE_COLUMNS) : {}),
      enrichmentAttempts: w.row.enrichmentAttempts,
      priorityScore: w.row.priorityScore,
      updatedAt: nowIso,
    };
    stmts.push(db.update(mediaItems).set(set).where(eq(mediaItems.id, w.row.id)));
  }

  for (const f of failures) {
    if (deleted.has(f.row.id)) continue;
    const attempts = f.row.enrichmentAttempts + 1;
    stmts.push(
      db
        .update(mediaItems)
        .set({
          enrichmentAttempts: attempts,
          enrichmentError: f.message,
          enrichmentStatus: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          updatedAt: nowIso,
        })
        .where(eq(mediaItems.id, f.row.id)),
    );
    summary.failed++;
  }

  if (stmts.length > 0) await db.batch(stmts as [BatchItem, ...BatchItem[]]);
  return summary;
}
