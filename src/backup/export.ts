import { asc, desc, eq, inArray } from "drizzle-orm";
import { curatedListItems, curatedLists, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { NEVER_EXPIRES } from "../api/time";
import { GoogleApiError, SubrequestBudgetError, createSubrequestBudget, valuesBatchClear, valuesBatchUpdate } from "../google/api";
import type { CellValue, SubrequestBudget } from "../google/api";
import { GoogleAuthError, getGoogleAccessToken, setCachedValue } from "../google/token";
import type { Db, GoogleEnv } from "../google/token";

export const LAST_BACKUP_KEY = "last_backup_at";
/** Rows written per tab per run. One extra row is read to detect truncation. */
export const MAX_ROWS_PER_TAB = 500;
export const MAX_CELL_CHARS = 2000;

export const TAB_LIBRARY = "Library_Archive";
export const TAB_ACTIVE = "Active_Queue";
export const TAB_LISTS = "Curated_Lists";

export interface BackupEnv extends GoogleEnv {
  BACKUP_SHEET_ID?: string;
}

const ITEM_COLS = {
  id: mediaItems.id,
  title: mediaItems.title,
  mediaType: mediaItems.mediaType,
  status: mediaItems.status,
  releaseYear: mediaItems.releaseYear,
  creator: mediaItems.creator,
  myRating: mediaItems.myRating,
  personalTier: mediaItems.personalTier,
  personalNotes: mediaItems.personalNotes,
  reviewText: mediaItems.reviewText,
  recommenderName: mediaItems.recommenderName,
  trustWeight: mediaItems.trustWeight,
  priorityScore: mediaItems.priorityScore,
  releaseState: mediaItems.releaseState,
  streamingProvidersJson: mediaItems.streamingProvidersJson,
  criticScore: mediaItems.criticScore,
  criticScoreDisplay: mediaItems.criticScoreDisplay,
  tmdbId: mediaItems.tmdbId,
  imdbId: mediaItems.imdbId,
  igdbId: mediaItems.igdbId,
  isbn13: mediaItems.isbn13,
  itunesId: mediaItems.itunesId,
  consumedYear: mediaItems.consumedYear,
  completedAt: mediaItems.completedAt,
  createdAt: mediaItems.createdAt,
  updatedAt: mediaItems.updatedAt,
};

type ItemRow = Pick<MediaItem, keyof typeof ITEM_COLS>;

/** Stable column order. At most 26 so the A2:Z clear covers every column. */
const ITEM_COLUMNS: [string, keyof ItemRow][] = [
  ["id", "id"],
  ["title", "title"],
  ["type", "mediaType"],
  ["status", "status"],
  ["release_year", "releaseYear"],
  ["creator", "creator"],
  ["my_rating", "myRating"],
  ["tier", "personalTier"],
  ["notes", "personalNotes"],
  ["review_text", "reviewText"],
  ["recommender", "recommenderName"],
  ["trust_weight", "trustWeight"],
  ["priority_score", "priorityScore"],
  ["release_state", "releaseState"],
  ["streaming", "streamingProvidersJson"],
  ["critic_score", "criticScore"],
  ["critic_display", "criticScoreDisplay"],
  ["tmdb_id", "tmdbId"],
  ["imdb_id", "imdbId"],
  ["igdb_id", "igdbId"],
  ["isbn13", "isbn13"],
  ["itunes_id", "itunesId"],
  ["consumed_year", "consumedYear"],
  ["completed_at", "completedAt"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
];

export const ITEM_HEADER: string[] = ITEM_COLUMNS.map((c) => c[0]);
export const LISTS_HEADER = ["list_title", "list_slug", "is_public", "rank", "item_title", "blurb"];

interface ListRow {
  listTitle: string;
  slug: string;
  isPublic: boolean;
  rank: number;
  itemTitle: string;
  blurb: string;
}

/** Strings only: leading =,+,-,@ (and tab/CR) get a single quote so Sheets never evaluates them. Then capped. */
export function sanitizeCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  let s = String(v);
  if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS);
  const c = s.charCodeAt(0);
  // = + - @ \t \r
  if (c === 61 || c === 43 || c === 45 || c === 64 || c === 9 || c === 13) s = "'" + s;
  return s;
}

const itemRow = (r: ItemRow): CellValue[] => ITEM_COLUMNS.map(([, k]) => sanitizeCell(r[k]));
const listRow = (r: ListRow): CellValue[] => [r.listTitle, r.slug, r.isPublic, r.rank, r.itemTitle, r.blurb].map(sanitizeCell);

const LIBRARY_STATUSES = ["Completed", "Abandoned", "Archived"] as const;
const ACTIVE_STATUSES = ["Backlog", "Up Next", "Active", "Paused"] as const;

export interface BackupCounts {
  library: number;
  active: number;
  lists: number;
}
export interface BackupTruncated {
  library: boolean;
  active: boolean;
  lists: boolean;
}

export type BackupResult =
  | { skipped: "not-configured" }
  | { rows: BackupCounts; truncated: BackupTruncated; lastBackupAt: string };

export interface BackupDeps {
  db: Db;
  env: BackupEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now?: () => Date;
}

function cap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > MAX_ROWS_PER_TAB
    ? { rows: rows.slice(0, MAX_ROWS_PER_TAB), truncated: true }
    : { rows, truncated: false };
}

export async function exportToSheets(deps: BackupDeps): Promise<BackupResult> {
  const { db, env } = deps;
  const sheetId = env.BACKUP_SHEET_ID;
  if (!sheetId || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) return { skipped: "not-configured" };
  const now = (deps.now ?? (() => new Date()))();
  const budget = deps.budget ?? createSubrequestBudget(50);

  // Reads only, each bounded. One extra row tells us whether the tab was capped.
  const [libraryRaw, activeRaw, listsRaw] = await Promise.all([
    db
      .select(ITEM_COLS)
      .from(mediaItems)
      .where(inArray(mediaItems.status, [...LIBRARY_STATUSES]))
      .orderBy(desc(mediaItems.updatedAt), asc(mediaItems.id))
      .limit(MAX_ROWS_PER_TAB + 1),
    db
      .select(ITEM_COLS)
      .from(mediaItems)
      .where(inArray(mediaItems.status, [...ACTIVE_STATUSES]))
      .orderBy(desc(mediaItems.priorityScore), asc(mediaItems.id))
      .limit(MAX_ROWS_PER_TAB + 1),
    db
      .select({
        listTitle: curatedLists.title,
        slug: curatedLists.slug,
        isPublic: curatedLists.isPublic,
        rank: curatedListItems.rank,
        itemTitle: mediaItems.title,
        blurb: curatedListItems.blurb,
      })
      .from(curatedListItems)
      .innerJoin(curatedLists, eq(curatedListItems.listId, curatedLists.id))
      .innerJoin(mediaItems, eq(curatedListItems.mediaItemId, mediaItems.id))
      .orderBy(asc(curatedLists.title), asc(curatedLists.id), asc(curatedListItems.rank))
      .limit(MAX_ROWS_PER_TAB + 1),
  ]);
  const library = cap(libraryRaw);
  const active = cap(activeRaw);
  const lists = cap(listsRaw);

  const token = await getGoogleAccessToken({ db, env, fetchImpl: deps.fetchImpl, nowSeconds: Math.floor(now.getTime() / 1000), budget });
  const opts = { token, fetchImpl: deps.fetchImpl, budget };

  await valuesBatchClear(sheetId, [`${TAB_LIBRARY}!A2:Z`, `${TAB_ACTIVE}!A2:Z`, `${TAB_LISTS}!A2:Z`], opts);
  await valuesBatchUpdate(
    sheetId,
    [
      { range: `${TAB_LIBRARY}!A1`, values: [ITEM_HEADER, ...library.rows.map(itemRow)] },
      { range: `${TAB_ACTIVE}!A1`, values: [ITEM_HEADER, ...active.rows.map(itemRow)] },
      { range: `${TAB_LISTS}!A1`, values: [LISTS_HEADER, ...lists.rows.map(listRow)] },
    ],
    opts,
  );

  const lastBackupAt = now.toISOString();
  await setCachedValue(db, LAST_BACKUP_KEY, lastBackupAt, NEVER_EXPIRES);
  return {
    rows: { library: library.rows.length, active: active.rows.length, lists: lists.rows.length },
    truncated: { library: library.truncated, active: active.truncated, lists: lists.truncated },
    lastBackupAt,
  };
}

/** Maps known failures to messages that never carry key material or Google's raw error text. */
export function safeBackupError(e: unknown): { status: 502 | 500; error: string; message: string } {
  if (e instanceof GoogleApiError) {
    return { status: 502, error: "backup_failed", message: `Google Sheets request failed (HTTP ${e.status}).` };
  }
  if (e instanceof GoogleAuthError) {
    return { status: 502, error: "backup_failed", message: "Google authentication failed." };
  }
  if (e instanceof SubrequestBudgetError) {
    return { status: 502, error: "backup_failed", message: "Subrequest budget exceeded." };
  }
  return { status: 500, error: "internal_error", message: "Backup failed." };
}
