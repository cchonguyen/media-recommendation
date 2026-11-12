import { and, inArray, isNotNull, ne, sql, eq } from "drizzle-orm";
import { mediaItems } from "../db/schema";
import { priorityForRow } from "../enrichment/merge";
import { fetchOmdbRatings } from "../enrichment/omdb";
import { fetchTmdbById } from "../enrichment/tmdb";
import { SubrequestBudgetError, createSubrequestBudget } from "../google/api";
import type { SubrequestBudget } from "../google/api";
import type { Db } from "../google/token";

export const MAX_GROOM_ITEMS = 15;
export const MAX_GROOM_SUBREQUESTS = 30;
export const GROOMED_RELEASE_STATES = ["Upcoming", "In_Theaters_Limited", "In_Theaters_Wide", "Ongoing_TV"] as const;

export interface GroomingEnv {
  TMDB_API_KEY?: string;
  OMDB_API_KEY?: string;
}

export interface GroomingDeps {
  db: Db;
  env: GroomingEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now?: () => Date;
}

export interface GroomingSummary {
  considered: number;
  refreshed: number;
  failed: number;
  skipped?: "no-tmdb-key" | "budget";
}

type Stmt = Parameters<Db["batch"]>[0][number];

/**
 * Refreshes release-sensitive fields of upcoming/ongoing items by stored TMDB id. Never searches by title.
 * User-owned columns (status, rating, notes, review, enrichment_status/attempts) are never written.
 */
export async function runGrooming(deps: GroomingDeps): Promise<GroomingSummary> {
  const { db, env } = deps;
  const summary: GroomingSummary = { considered: 0, refreshed: 0, failed: 0 };
  if (!env.TMDB_API_KEY) return { ...summary, skipped: "no-tmdb-key" };

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const budget = deps.budget ?? createSubrequestBudget(MAX_GROOM_SUBREQUESTS);
  const perItemWorstCase = env.OMDB_API_KEY ? 2 : 1;

  const rows = await db
    .select()
    .from(mediaItems)
    .where(
      and(
        inArray(mediaItems.releaseState, [...GROOMED_RELEASE_STATES]),
        ne(mediaItems.status, "Archived"),
        inArray(mediaItems.mediaType, ["Movie", "TV"]),
        isNotNull(mediaItems.tmdbId),
      ),
    )
    .orderBy(sql`${mediaItems.lastEnrichedAt} ASC NULLS FIRST`, mediaItems.id)
    .limit(MAX_GROOM_ITEMS);

  const stmts: Stmt[] = [];
  for (const row of rows) {
    if (budget.limit - budget.used < perItemWorstCase) {
      summary.skipped = "budget";
      break;
    }
    summary.considered++;
    try {
      const res = await fetchTmdbById({
        mediaType: row.mediaType as "Movie" | "TV",
        tmdbId: row.tmdbId!,
        apiKey: env.TMDB_API_KEY,
        fetchImpl: deps.fetchImpl,
        budget,
        now,
      });
      if (res.kind !== "ok") throw new Error("not-found");
      const f = res.fields;
      const imdbId = row.imdbId ?? f.imdbId ?? null;
      let criticScore = row.criticScore;
      let criticScoreDisplay = row.criticScoreDisplay;
      if (imdbId && env.OMDB_API_KEY) {
        const r = await fetchOmdbRatings({ imdbId, apiKey: env.OMDB_API_KEY, fetchImpl: deps.fetchImpl, budget });
        if (r.criticScore !== null) {
          criticScore = r.criticScore;
          criticScoreDisplay = r.criticScoreDisplay;
        }
      }
      const next = {
        imdbId,
        releaseYear: f.releaseYear ?? row.releaseYear,
        releaseDate: f.releaseDate ?? row.releaseDate,
        releaseState: f.releaseState ?? row.releaseState,
        releaseAccessDisplay: f.releaseAccessDisplay ?? row.releaseAccessDisplay,
        streamingProvidersJson: f.streamingProvidersJson ?? row.streamingProvidersJson,
        isAvailableNow: f.isAvailableNow ?? row.isAvailableNow,
        criticScore,
        criticScoreDisplay,
      };
      const priorityScore = priorityForRow({ ...row, ...next }, now);
      stmts.push(
        db
          .update(mediaItems)
          .set({ ...next, priorityScore, lastEnrichedAt: nowIso, updatedAt: nowIso })
          .where(eq(mediaItems.id, row.id)),
      );
      summary.refreshed++;
    } catch (e) {
      if (e instanceof SubrequestBudgetError) {
        summary.skipped = "budget";
        summary.considered--;
        break;
      }
      summary.failed++;
      // Rotate the item to the back of the queue so permanent failures cannot starve the rest.
      stmts.push(db.update(mediaItems).set({ lastEnrichedAt: nowIso }).where(eq(mediaItems.id, row.id)));
    }
  }

  if (stmts.length > 0) await db.batch(stmts as [Stmt, ...Stmt[]]);
  return summary;
}
