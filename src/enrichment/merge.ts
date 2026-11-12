import { and, eq, ne } from "drizzle-orm";
import { activityLog, curatedListItems, mediaItems } from "../db/schema";
import type { MediaItem, NewMediaItem } from "../db/schema";
import type { Db } from "../google/token";
import { unionNames } from "../intake/ingest";
import { pacificDayAndHour } from "../intake/pacific";
import { computePriorityScore } from "./priority";
import { ENRICH_COLUMNS } from "./types";

export type BatchItem = Parameters<Db["batch"]>[0][number];

/** Columns that identify a canonical item. Slice 5 enrichers reuse this list unchanged. */
export const EXTERNAL_ID_COLUMNS = ["tmdbId", "igdbId", "isbn13", "itunesId"] as const;

/** Columns a merge may change on the survivor, besides the enrichment columns. */
export const MERGE_COLUMNS = [
  "recommenderName",
  "recommenderCount",
  "trustWeight",
  "personalNotes",
  "alternativeMatchesNote",
  "myRating",
  "personalTier",
  "reviewText",
  "reviewDone",
  "consumedYear",
  "completedAt",
] as const satisfies readonly (keyof MediaItem)[];

/** A row held in memory during a queue run, with what must be written for it. */
export interface WorkingRow {
  row: MediaItem;
  /** Enrichment columns changed. */
  enriched: boolean;
  /** Merge columns changed. */
  merged: boolean;
}

function appendNotes(existing: string, extra: string): string {
  const add = extra.trim();
  if (!add || existing.includes(add)) return existing;
  return existing ? `${existing} | ${add}` : add;
}

const splitNames = (s: string) => s.split(",").map((n) => n.trim());

export function priorityForRow(row: MediaItem, now: Date): number {
  return computePriorityScore(
    {
      trustWeight: row.trustWeight,
      criticScore: row.criticScore,
      recommenderCount: row.recommenderCount,
      isAvailableNow: row.isAvailableNow,
      releaseDate: row.releaseDate,
      releaseYear: row.releaseYear,
    },
    now,
  );
}

/** The older row (created_at, tie by id) survives. */
export function orderByAge(a: MediaItem, b: MediaItem): [survivor: MediaItem, duplicate: MediaItem] {
  const cmp = a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return cmp <= 0 ? [a, b] : [b, a];
}

/** Pure Stage 2 field merge. Returns the survivor's final state. */
export function mergeRows(survivor: MediaItem, dup: MediaItem, now: Date): MediaItem {
  const names = unionNames(splitNames(survivor.recommenderName), splitNames(dup.recommenderName));
  const out: MediaItem = {
    ...survivor,
    recommenderName: names.join(", ") || survivor.recommenderName,
    recommenderCount: Math.max(1, names.length),
    trustWeight: Math.max(survivor.trustWeight, dup.trustWeight),
    personalNotes: appendNotes(survivor.personalNotes, dup.personalNotes),
    alternativeMatchesNote: appendNotes(survivor.alternativeMatchesNote, dup.alternativeMatchesNote),
    myRating: survivor.myRating ?? dup.myRating,
    personalTier: survivor.personalTier ?? dup.personalTier,
    reviewText: survivor.reviewText || dup.reviewText,
    reviewDone: survivor.reviewDone || dup.reviewDone,
    consumedYear: survivor.consumedYear ?? dup.consumedYear,
    completedAt: survivor.completedAt ?? dup.completedAt,
    updatedAt: now.toISOString(),
  };
  // Enriched data: the survivor's if it has it, else the duplicate's.
  if (survivor.enrichmentStatus !== "ENRICHED" && dup.enrichmentStatus === "ENRICHED") {
    for (const c of ENRICH_COLUMNS) (out as Record<string, unknown>)[c] = dup[c];
    out.enrichmentAttempts = dup.enrichmentAttempts;
  }
  out.priorityScore = priorityForRow(out, now);
  return out;
}

/**
 * Finds rows sharing (media_type, external id) with the working row, in the database (any status,
 * archived included) and among rows already enriched earlier in this run, and builds the
 * statements that fold each newer duplicate into the older survivor. Nothing is written here:
 * statements go into `out` so the queue can send everything in one db.batch.
 * Returns the id that ends up holding the data and the number of merges planned.
 */
export async function planCanonicalMerges(args: {
  db: Db;
  targetId: string;
  working: Map<string, WorkingRow>;
  deleted: Set<string>;
  now: Date;
  out: BatchItem[];
  columns?: readonly (typeof EXTERNAL_ID_COLUMNS)[number][];
}): Promise<{ survivorId: string; merges: number }> {
  const { db, working, deleted, now, out } = args;
  const nowIso = now.toISOString();
  const { dayOfWeekPt, hourOfDayPt } = pacificDayAndHour(now);
  let currentId = args.targetId;
  let merges = 0;

  for (const col of args.columns ?? EXTERNAL_ID_COLUMNS) {
    const value = working.get(currentId)!.row[col];
    if (!value) continue;
    const type = working.get(currentId)!.row.mediaType;

    const dbRows = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.mediaType, type), eq(mediaItems[col], value), ne(mediaItems.id, currentId)));
    const candidates = new Map<string, WorkingRow>();
    for (const r of dbRows) {
      if (!deleted.has(r.id)) candidates.set(r.id, working.get(r.id) ?? { row: r, enriched: false, merged: false });
    }
    for (const [id, w] of working) {
      if (id !== currentId && !deleted.has(id) && w.row.mediaType === type && w.row[col] === value) candidates.set(id, w);
    }

    for (const cand of candidates.values()) {
      const cur = working.get(currentId)!;
      const [s, d] = orderByAge(cur.row, cand.row);
      const sw = s.id === cur.row.id ? cur : cand;
      const merged = mergeRows(s, d, now);
      const gainedEnrichment = s.enrichmentStatus !== "ENRICHED";
      working.set(s.id, { row: merged, enriched: sw.enriched || gainedEnrichment, merged: true });
      working.delete(d.id);
      deleted.add(d.id);
      out.push(
        db.update(activityLog).set({ itemId: s.id }).where(eq(activityLog.itemId, d.id)),
        db.update(curatedListItems).set({ mediaItemId: s.id }).where(eq(curatedListItems.mediaItemId, d.id)),
        db.insert(activityLog).values({
          itemId: s.id,
          itemTitleSnapshot: s.title,
          mediaType: s.mediaType,
          eventType: "CANONICAL_MERGE",
          oldValue: d.id,
          newValue: s.id,
          dayOfWeekPt,
          hourOfDayPt,
          createdAt: nowIso,
        }),
        db.delete(mediaItems).where(eq(mediaItems.id, d.id)),
      );
      currentId = s.id;
      merges++;
    }
  }
  return { survivorId: currentId, merges };
}

export function pickColumns<K extends keyof MediaItem>(row: MediaItem, keys: readonly K[]): Partial<NewMediaItem> {
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = row[k];
  return o as Partial<NewMediaItem>;
}
