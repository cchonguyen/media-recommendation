import { and, inArray, ne, sql } from "drizzle-orm";
import { activityLog, intakeLog, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { MAX_LINES_PER_RUN, hashLine } from "./lines";
import { parseLines } from "./parse";
import { GeminiError } from "./gemini";
import type { MediaType, ParsedItem } from "./gemini";
import { setCachedValue } from "../google/token";
import { pacificDayAndHour } from "./pacific";
import type { IngestDeps } from "./types";

export const PARSE_DIAG_KEY = "last_parse_diag";

export type IntakeSource = "gdoc" | "webhook";

export interface IngestedItem {
  id: string;
  title: string;
  mediaType: MediaType;
  status: string;
  merged: boolean;
}

export interface IngestResult {
  accepted: number;
  merged: number;
  created: number;
  skippedDuplicates: number;
  unparsedLines: string[];
  rejected: number;
  remaining: number;
  items: IngestedItem[];
}

interface Group {
  title: string;
  mediaType: MediaType;
  yearHint: number | null;
  rawInput: string;
  names: string[];
  trustWeight: number;
  notes: string;
  isAlreadyConsumed: boolean;
  myRating: number | null;
  consumedYear: number | null;
  alt: string;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `itm_${hex}`;
}

/** Case-insensitive union via a Set. The first-seen casing is kept. */
export function unionNames(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...existing, ...incoming]) {
    const name = n.trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

function appendNotes(existing: string, extra: string): string {
  const add = extra.trim();
  if (!add || existing.includes(add)) return existing;
  return existing ? `${existing} | ${add}` : add;
}

function groupKey(i: { title: string; mediaType: string; yearHint: number | null }): string {
  return `${i.title.toLowerCase()}\u0000${i.mediaType}\u0000${i.yearHint ?? ""}`;
}

export async function ingestRawLines(
  deps: IngestDeps,
  lines: string[],
  source: IntakeSource,
): Promise<IngestResult> {
  const { db, env } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  const taken = nonEmpty.slice(0, MAX_LINES_PER_RUN);
  const remaining = nonEmpty.length - taken.length;

  const candidates: { raw: string; hash: string }[] = [];
  const inBatch = new Set<string>();
  let skippedDuplicates = 0;
  for (const raw of taken) {
    const hash = await hashLine(raw);
    if (inBatch.has(hash)) {
      skippedDuplicates++;
      continue;
    }
    inBatch.add(hash);
    candidates.push({ raw, hash });
  }

  const empty = (): IngestResult => ({
    accepted: 0,
    merged: 0,
    created: 0,
    skippedDuplicates,
    unparsedLines: [],
    rejected: 0,
    remaining,
    items: [],
  });
  if (candidates.length === 0) return empty();

  const known = await db
    .select({ hash: intakeLog.lineHash, rawLine: intakeLog.rawLine })
    .from(intakeLog)
    .where(inArray(intakeLog.lineHash, candidates.map((c) => c.hash)));
  // A logged line only counts as seen if its item exists. Older buggy sweeps logged lines that were
  // never saved; those are reprocessed so they heal instead of being skipped and deleted.
  const loggedHashes = new Set(known.map((k) => k.hash));
  const savedRaw = new Set<string>();
  if (known.length > 0) {
    const rows = await db
      .select({ raw: mediaItems.rawInput })
      .from(mediaItems)
      .where(inArray(mediaItems.rawInput, known.map((k) => k.rawLine)));
    for (const r of rows) savedRaw.add(r.raw);
  }
  const knownSet = new Set(known.filter((k) => savedRaw.has(k.rawLine)).map((k) => k.hash));
  const fresh = candidates.filter((c) => !knownSet.has(c.hash));
  skippedDuplicates += candidates.length - fresh.length;
  if (fresh.length === 0) return empty();

  // A Gemini failure throws here, before anything is written.
  // The last parser diagnostic lives in system_kv so a failure can be read from D1. It never fails a run.
  const saveDiag = async (text: string) => {
    try {
      const value = JSON.stringify({ at: nowIso, lines: fresh.length, source, diag: text.slice(0, 1500) });
      await setCachedValue(db, PARSE_DIAG_KEY, value, Math.floor(now.getTime() / 1000) + 30 * 86400);
    } catch {
      // Telemetry only.
    }
  };
  let parsed: Awaited<ReturnType<typeof parseLines>>;
  try {
    parsed = await parseLines({
      lines: fresh.map((f) => f.raw),
      env,
      fetchImpl: deps.fetchImpl,
      budget: deps.budget,
    });
  } catch (e) {
    if (e instanceof GeminiError) await saveDiag(`FAILED: ${e.message}${e.detail ? ` | ${e.detail}` : ""}`);
    throw e;
  }
  if (parsed.items.length === 0 || parsed.rejected > 0 || parsed.degraded) await saveDiag(parsed.diag ?? `parsed ${parsed.items.length} items, ${parsed.rejected} rejected`);

  const linesWithItems = new Set<number>();
  const groups = new Map<string, Group>();
  for (const it of parsed.items as ParsedItem[]) {
    linesWithItems.add(it.lineIndex);
    const key = groupKey(it);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        title: it.title,
        mediaType: it.mediaType,
        yearHint: it.yearHint,
        rawInput: fresh[it.lineIndex]!.raw,
        names: [it.recommenderName],
        trustWeight: it.trustWeight,
        notes: it.personalNotes.trim(),
        isAlreadyConsumed: it.isAlreadyConsumed,
        myRating: it.myRating,
        consumedYear: it.consumedYear,
        alt: it.alternativeMatchesNote,
      });
    } else {
      g.names = unionNames(g.names, [it.recommenderName]);
      g.trustWeight = Math.max(g.trustWeight, it.trustWeight);
      g.notes = appendNotes(g.notes, it.personalNotes);
      g.isAlreadyConsumed = g.isAlreadyConsumed || it.isAlreadyConsumed;
      g.myRating = g.myRating ?? it.myRating;
      g.consumedYear = g.consumedYear ?? it.consumedYear;
      g.alt = g.alt || it.alternativeMatchesNote;
    }
  }

  const unparsedLines = fresh.filter((_, i) => !linesWithItems.has(i)).map((f) => f.raw);

  // One read for every candidate title, then match in memory.
  const titles = [...new Set([...groups.values()].map((g) => g.title.toLowerCase()))];
  const existingRows: MediaItem[] = titles.length
    ? await db
        .select()
        .from(mediaItems)
        .where(and(ne(mediaItems.status, "Archived"), inArray(sql`lower(${mediaItems.title})`, titles)))
        .orderBy(mediaItems.createdAt)
    : [];

  /*
   * Stage 1 year rule (locked): "year hint matches release year or is unspecified on both".
   * The item's yearHint equals the row's release_year (or the row's year_hint when release_year
   * is null), OR the item has no hint and the row has neither release_year nor year_hint.
   * An enriched row with a known year and a no-hint item therefore do NOT merge here;
   * Stage 2 (canonical merge on external IDs) handles that later.
   */
  const findMatch = (g: Group): MediaItem | undefined =>
    existingRows.find((r) => {
      if (r.title.toLowerCase() !== g.title.toLowerCase() || r.mediaType !== g.mediaType) return false;
      const rowYear = r.releaseYear ?? r.yearHint;
      return g.yearHint === null ? rowYear === null : rowYear === g.yearHint;
    });

  const { dayOfWeekPt, hourOfDayPt } = pacificDayAndHour(now);
  const stmts: Parameters<typeof db.batch>[0][number][] = [];
  const outItems: IngestedItem[] = [];
  let merged = 0;
  let created = 0;

  for (const g of groups.values()) {
    const match = findMatch(g);
    if (match) {
      const oldNames = match.recommenderName.split(",").map((n) => n.trim());
      const names = unionNames(oldNames, g.names);
      const newName = names.join(", ");
      stmts.push(
        db
          .update(mediaItems)
          .set({
            recommenderName: newName,
            recommenderCount: names.length,
            trustWeight: Math.max(match.trustWeight, g.trustWeight),
            personalNotes: appendNotes(match.personalNotes, g.notes),
            updatedAt: nowIso,
          })
          .where(sql`${mediaItems.id} = ${match.id}`),
        db.insert(activityLog).values({
          itemId: match.id,
          itemTitleSnapshot: match.title,
          mediaType: match.mediaType,
          eventType: "MERGED_RECOMMENDATION",
          oldValue: match.recommenderName,
          newValue: newName,
          dayOfWeekPt,
          hourOfDayPt,
          createdAt: nowIso,
        }),
      );
      merged++;
      outItems.push({ id: match.id, title: match.title, mediaType: match.mediaType, status: match.status, merged: true });
      continue;
    }
    const id = randomId();
    const status = g.isAlreadyConsumed ? "Completed" : "Backlog";
    stmts.push(
      db.insert(mediaItems).values({
        id,
        title: g.title,
        rawInput: g.rawInput,
        yearHint: g.yearHint,
        mediaType: g.mediaType,
        status,
        enrichmentStatus: "PENDING",
        recommenderName: g.names.join(", ") || "Self",
        recommenderCount: Math.max(1, g.names.length),
        trustWeight: g.trustWeight,
        personalNotes: g.notes,
        myRating: g.myRating,
        consumedYear: g.consumedYear,
        completedAt: status === "Completed" ? nowIso : null,
        reviewDone: Boolean(g.myRating),
        alternativeMatchesNote: g.alt,
        lastStatusChangeAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      db.insert(activityLog).values({
        itemId: id,
        itemTitleSnapshot: g.title,
        mediaType: g.mediaType,
        eventType: "CREATED",
        oldValue: null,
        newValue: null,
        dayOfWeekPt,
        hourOfDayPt,
        createdAt: nowIso,
      }),
    );
    created++;
    outItems.push({ id, title: g.title, mediaType: g.mediaType, status, merged: false });
  }

  // Unparsed lines are not logged: they stay in the Doc and are retried, never silently consumed.
  const unparsedSet = new Set(unparsedLines);
  for (const f of fresh) {
    if (unparsedSet.has(f.raw)) continue;
    const entry = db.insert(intakeLog).values({ lineHash: f.hash, rawLine: f.raw, source, createdAt: nowIso });
    // Only a stale entry from an earlier run may be overwritten; a concurrent run's entry must still conflict.
    stmts.push(loggedHashes.has(f.hash) ? entry.onConflictDoNothing() : entry);
  }

  if (stmts.length === 0) {
    return { ...empty(), unparsedLines, rejected: parsed.rejected };
  }

  try {
    await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  } catch (err) {
    // D1 batches are transactional: a concurrent run that logged any of these lines fails the
    // whole batch. If every hash is now present, that run did the work.
    const newHashes = fresh.filter((f) => !unparsedSet.has(f.raw) && !loggedHashes.has(f.hash)).map((f) => f.hash);
    if (newHashes.length > 0) {
      const now2 = await db.select({ hash: intakeLog.lineHash }).from(intakeLog).where(inArray(intakeLog.lineHash, newHashes));
      if (now2.length === newHashes.length) {
        return { ...empty(), skippedDuplicates: skippedDuplicates + fresh.length };
      }
    }
    throw err;
  }

  return {
    accepted: fresh.length - unparsedLines.length,
    merged,
    created,
    skippedDuplicates,
    unparsedLines,
    rejected: parsed.rejected,
    remaining,
    items: outItems,
  };
}
