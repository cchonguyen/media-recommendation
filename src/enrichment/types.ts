import type { SubrequestBudget } from "../google/api";
import type { MediaItem } from "../db/schema";
import type { Db } from "../google/token";

export interface EnrichmentEnv {
  TMDB_API_KEY?: string;
  OMDB_API_KEY?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  /** Optional: Google Books works without a key at a lower quota. */
  GOOGLE_BOOKS_API_KEY?: string;
}

/** Columns an enricher may set. The queue and merge treat these as one unit. */
export const ENRICH_COLUMNS = [
  "tmdbId",
  "imdbId",
  "igdbId",
  "isbn13",
  "itunesId",
  "sourceUrl",
  "releaseYear",
  "releaseDate",
  "releaseState",
  "releaseAccessDisplay",
  "streamingProvidersJson",
  "genresJson",
  "isAvailableNow",
  "criticScore",
  "criticScoreDisplay",
  "timeCommitmentDisplay",
  "timeCommitmentMinutes",
  "creator",
  "amazonLink",
  "posterImageUrl",
  "categoryMetadataJson",
  "lastEnrichedAt",
  "enrichmentStatus",
  "enrichmentError",
] as const satisfies readonly (keyof MediaItem)[];

export type EnrichColumn = (typeof ENRICH_COLUMNS)[number];
export type EnrichedFields = Partial<Pick<MediaItem, EnrichColumn>>;

export type EnrichOutcome = { kind: "ok"; fields: EnrichedFields } | { kind: "not-found" };

export interface EnrichContext {
  db: Db;
  row: MediaItem;
  env: EnrichmentEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now: Date;
}

export interface Enricher {
  /** Worst-case outbound subrequests for one item. The queue stops before exceeding the budget. */
  subrequestsNeeded(env: EnrichmentEnv): number;
  /** False when a required API key is missing: the queue skips without counting an attempt. */
  hasCredentials(env: EnrichmentEnv): boolean;
  enrich(ctx: EnrichContext): Promise<EnrichOutcome>;
}
