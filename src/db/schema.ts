import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const MEDIA_TYPES = ["Movie", "TV", "Book", "Game", "Podcast", "One-Off"] as const;
export const STATUSES = [
  "Backlog",
  "Up Next",
  "Active",
  "Paused",
  "Completed",
  "Abandoned",
  "Archived",
] as const;
export const ENRICHMENT_STATUSES = ["PENDING", "ENRICHED", "FAILED", "SKIPPED"] as const;
export const TIERS = ["S", "A", "B", "C", "D"] as const;
export const RELEASE_STATES = [
  "Upcoming",
  "In_Theaters_Limited",
  "In_Theaters_Wide",
  "Streaming",
  "Published",
  "Ongoing_TV",
  "Ended_TV",
  "Unknown",
] as const;
export const EVENT_TYPES = [
  "CREATED",
  "STATUS_CHANGE",
  "TYPE_OVERRIDE",
  "RATING_LOGGED",
  "REVIEW_COMPLETED",
  "MERGED_RECOMMENDATION",
  "CANONICAL_MERGE",
] as const;

export const mediaItems = sqliteTable(
  "media_items",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    rawInput: text("raw_input").notNull(),
    yearHint: integer("year_hint"),
    mediaType: text("media_type", { enum: MEDIA_TYPES }).notNull(),
    status: text("status", { enum: STATUSES }).notNull().default("Backlog"),
    enrichmentStatus: text("enrichment_status", { enum: ENRICHMENT_STATUSES })
      .notNull()
      .default("PENDING"),
    enrichmentAttempts: integer("enrichment_attempts").notNull().default(0),
    enrichmentError: text("enrichment_error"),
    tmdbId: text("tmdb_id"),
    imdbId: text("imdb_id"),
    igdbId: text("igdb_id"),
    isbn13: text("isbn13"),
    itunesId: text("itunes_id"),
    sourceUrl: text("source_url"),
    recommenderName: text("recommender_name").notNull().default("Self"),
    recommenderCount: integer("recommender_count").notNull().default(1),
    trustWeight: integer("trust_weight").notNull().default(3),
    personalNotes: text("personal_notes").notNull().default(""),
    myRating: real("my_rating"),
    personalTier: text("personal_tier", { enum: TIERS }),
    reviewText: text("review_text").notNull().default(""),
    reviewDone: integer("review_done", { mode: "boolean" }).notNull().default(false),
    consumedYear: integer("consumed_year"),
    completedAt: text("completed_at"),
    creator: text("creator").notNull().default(""),
    releaseYear: integer("release_year"),
    releaseDate: text("release_date"),
    releaseState: text("release_state", { enum: RELEASE_STATES }).notNull().default("Unknown"),
    releaseAccessDisplay: text("release_access_display").notNull().default("Unknown"),
    streamingProvidersJson: text("streaming_providers_json").notNull().default("[]"),
    genresJson: text("genres_json").notNull().default("[]"),
    isAvailableNow: integer("is_available_now", { mode: "boolean" }).notNull().default(false),
    criticScore: real("critic_score"),
    criticScoreDisplay: text("critic_score_display").notNull().default(""),
    timeCommitmentDisplay: text("time_commitment_display").notNull().default(""),
    timeCommitmentMinutes: integer("time_commitment_minutes"),
    amazonLink: text("amazon_link").notNull().default(""),
    posterImageUrl: text("poster_image_url").notNull().default(""),
    alternativeMatchesNote: text("alternative_matches_note").notNull().default(""),
    categoryMetadataJson: text("category_metadata_json").notNull().default("{}"),
    priorityScore: real("priority_score").notNull().default(51.0),
    lastStatusChangeAt: text("last_status_change_at").notNull(),
    lastEnrichedAt: text("last_enriched_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_media_items_status").on(t.status),
    index("idx_media_items_enrichment_status").on(t.enrichmentStatus),
    index("idx_media_items_media_type").on(t.mediaType),
    index("idx_media_items_priority_score").on(t.priorityScore),
    index("idx_media_items_release_year").on(t.releaseYear),
    index("idx_media_items_consumed_year").on(t.consumedYear),
  ],
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: text("item_id").references(() => mediaItems.id, { onDelete: "set null" }),
    itemTitleSnapshot: text("item_title_snapshot").notNull(),
    mediaType: text("media_type").notNull(),
    eventType: text("event_type", { enum: EVENT_TYPES }).notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    dayOfWeekPt: integer("day_of_week_pt").notNull(),
    hourOfDayPt: integer("hour_of_day_pt").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_activity_log_item_id").on(t.itemId),
    index("idx_activity_log_created_at").on(t.createdAt),
  ],
);

export const intakeLog = sqliteTable("intake_log", {
  lineHash: text("line_hash").primaryKey(),
  rawLine: text("raw_line").notNull(),
  source: text("source", { enum: ["gdoc", "webhook"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const systemKv = sqliteTable("system_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const curatedLists = sqliteTable(
  "curated_lists",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    mediaTypeFilter: text("media_type_filter"),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("idx_curated_lists_slug").on(t.slug)],
);

export const curatedListItems = sqliteTable(
  "curated_list_items",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => curatedLists.id, { onDelete: "cascade" }),
    mediaItemId: text("media_item_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    blurb: text("blurb").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_curated_list_items_list_rank").on(t.listId, t.rank)],
);

export type MediaItem = typeof mediaItems.$inferSelect;
export type NewMediaItem = typeof mediaItems.$inferInsert;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type NewActivityLogRow = typeof activityLog.$inferInsert;
export type IntakeLogRow = typeof intakeLog.$inferSelect;
export type NewIntakeLogRow = typeof intakeLog.$inferInsert;
export type SystemKvRow = typeof systemKv.$inferSelect;
export type NewSystemKvRow = typeof systemKv.$inferInsert;
export type CuratedList = typeof curatedLists.$inferSelect;
export type NewCuratedList = typeof curatedLists.$inferInsert;
export type CuratedListItem = typeof curatedListItems.$inferSelect;
export type NewCuratedListItem = typeof curatedListItems.$inferInsert;

