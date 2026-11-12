import { Hono } from "hono";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { activityLog, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { computePriorityScore } from "../enrichment/priority";
import { GoogleAuthError, getCachedValue } from "../google/token";
import type { Db } from "../google/token";
import { GoogleApiError, SubrequestBudgetError } from "../google/api";
import { GeminiError } from "../intake/gemini";
import { sweepInboxDoc } from "../intake/doc-sweep";
import type { SweepDeps, SweepResult } from "../intake/doc-sweep";
import { pacificDayAndHour } from "../intake/pacific";
import type { IntakeEnv } from "../intake/types";
import { LAST_INBOX_SYNC_KEY, pacificYearOf, recordInboxSync } from "./time";
import {
  ApiError,
  MAX_TITLE,
  freeText,
  invalid,
  isMediaType,
  isStatus,
  isTier,
  isValidRating,
  nullableExternalId,
  nullableUrl,
  nullableYear,
  rejectUnknown,
  requireObject,
  splitTitleYear,
  textField,
} from "./validate";
import type { MediaType, Tier } from "./validate";

export interface ApiOptions {
  now?: () => Date;
  sweep?: (deps: SweepDeps) => Promise<SweepResult>;
}

type ApiEnv = IntakeEnv & { DB: D1Database };
type Stmt = Parameters<Db["batch"]>[0][number];
type LogRow = typeof activityLog.$inferInsert;

export const SORT_COLUMNS = {
  priority_score: mediaItems.priorityScore,
  title: mediaItems.title,
  created_at: mediaItems.createdAt,
  release_year: mediaItems.releaseYear,
  consumed_year: mediaItems.consumedYear,
  my_rating: mediaItems.myRating,
  completed_at: mediaItems.completedAt,
} as const;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const EXTERNAL_ID_FIELDS = [
  ["tmdb_id", "tmdbId"],
  ["imdb_id", "imdbId"],
  ["igdb_id", "igdbId"],
  ["isbn13", "isbn13"],
  ["itunes_id", "itunesId"],
] as const;

const PATCH_FIELDS = [
  "title",
  "media_type",
  "personal_notes",
  "personal_tier",
  "review_text",
  "source_url",
  "year_hint",
  "trust_weight",
  ...EXTERNAL_ID_FIELDS.map((f) => f[0]),
] as const;

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return "itm_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON.");
  }
  return requireObject(body);
}

async function loadItem(db: Db, id: string): Promise<MediaItem> {
  const rows = await db.select().from(mediaItems).where(eq(mediaItems.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new ApiError(404, "not_found", "Item not found.");
  return row;
}

/** The only write path: one db.batch holding the item write and its activity rows. */
async function runBatch(db: Db, stmts: Stmt[]): Promise<void> {
  await db.batch(stmts as [Stmt, ...Stmt[]]);
}

function logRow(
  item: { id: string; title: string; mediaType: string },
  now: Date,
  eventType: LogRow["eventType"],
  oldValue: string | null,
  newValue: string | null,
): LogRow {
  const { dayOfWeekPt, hourOfDayPt } = pacificDayAndHour(now);
  return {
    itemId: item.id,
    itemTitleSnapshot: item.title,
    mediaType: item.mediaType,
    eventType,
    oldValue,
    newValue,
    dayOfWeekPt,
    hourOfDayPt,
    createdAt: now.toISOString(),
  };
}

function rescore(item: MediaItem, now: Date): number {
  return computePriorityScore(
    {
      trustWeight: item.trustWeight,
      criticScore: item.criticScore,
      recommenderCount: item.recommenderCount,
      isAvailableNow: item.isAvailableNow,
      releaseDate: item.releaseDate,
      releaseYear: item.releaseYear,
    },
    now,
  );
}

function parseIntParam(v: string | undefined, name: string, def: number, min: number): number {
  if (v === undefined || v === "") return def;
  if (!/^\d+$/.test(v)) throw new ApiError(400, "invalid_query", `${name} must be a non-negative integer.`);
  const n = Number(v);
  if (n < min) throw new ApiError(400, "invalid_query", `${name} must be at least ${min}.`);
  return n;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createApiRoutes(options: ApiOptions = {}) {
  const nowFn = options.now ?? (() => new Date());
  const sweep = options.sweep ?? sweepInboxDoc;
  const routes = new Hono<{ Bindings: ApiEnv }>();

  routes.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error("api failed", err instanceof Error ? err.name : "unknown");
    return c.json({ error: "internal_error" }, 500);
  });

  routes.get("/items", async (c) => {
    const db = drizzle(c.env.DB);
    const q = c.req.query();
    const conds: SQL[] = [];

    if (q.status !== undefined && q.status !== "") {
      if (!isStatus(q.status)) throw new ApiError(400, "invalid_query", "Unknown status.");
      conds.push(eq(mediaItems.status, q.status));
    } else {
      conds.push(ne(mediaItems.status, "Archived"));
    }
    if (q.type !== undefined && q.type !== "") {
      if (!isMediaType(q.type)) throw new ApiError(400, "invalid_query", "Unknown type.");
      conds.push(eq(mediaItems.mediaType, q.type));
    }
    if (q.q !== undefined && q.q.trim() !== "") {
      conds.push(sql`${mediaItems.title} LIKE ${"%" + escapeLike(q.q.trim().slice(0, 200)) + "%"} ESCAPE '\\'`);
    }

    const sortKey = q.sort === undefined || q.sort === "" ? "priority_score" : q.sort;
    if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sortKey)) {
      throw new ApiError(400, "invalid_query", "Unknown sort column.");
    }
    const order = q.order === undefined || q.order === "" ? "desc" : q.order.toLowerCase();
    if (order !== "asc" && order !== "desc") throw new ApiError(400, "invalid_query", "order must be asc or desc.");
    const col = SORT_COLUMNS[sortKey as keyof typeof SORT_COLUMNS];
    const dir = order === "asc" ? asc : desc;

    const limit = Math.min(parseIntParam(q.limit, "limit", DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = parseIntParam(q.offset, "offset", 0, 0);
    const where = and(...conds);

    const [items, totalRows] = await Promise.all([
      db.select().from(mediaItems).where(where).orderBy(dir(col), asc(mediaItems.id)).limit(limit).offset(offset),
      db.select({ n: sql<number>`count(*)` }).from(mediaItems).where(where),
    ]);
    return c.json({ items, total: Number(totalRows[0]?.n ?? 0) });
  });

  routes.get("/items/:id", async (c) => {
    return c.json(await loadItem(drizzle(c.env.DB), c.req.param("id")));
  });

  routes.post("/items", async (c) => {
    const db = drizzle(c.env.DB);
    const body = await readBody(c.req.raw);
    rejectUnknown(body, [
      "title",
      "media_type",
      "year_hint",
      "status",
      "recommender_name",
      "personal_notes",
      "source_url",
    ]);

    const rawTitle = textField(body.title, "title", { max: MAX_TITLE, nonEmpty: true });
    if (!isMediaType(body.media_type)) throw invalid("media_type", "must be one of the media types");
    const mediaType: MediaType = body.media_type;
    const { title, year } = splitTitleYear(rawTitle);
    let yearHint = body.year_hint === undefined ? null : nullableYear(body.year_hint, "year_hint");
    if (year !== null) yearHint = year;

    let status: (typeof mediaItems.$inferInsert)["status"] = "Backlog";
    if (body.status !== undefined) {
      if (!isStatus(body.status) || body.status === "Archived") throw invalid("status", "must be a non-archived status");
      status = body.status;
    }
    const recommender =
      body.recommender_name === undefined
        ? "Self"
        : textField(body.recommender_name, "recommender_name", { max: 200, nonEmpty: true });
    const notes = body.personal_notes === undefined ? "" : freeText(body.personal_notes, "personal_notes");
    const sourceUrl = body.source_url === undefined ? null : nullableUrl(body.source_url, "source_url");

    const now = nowFn();
    const iso = now.toISOString();
    const row: typeof mediaItems.$inferInsert = {
      id: newId(),
      title,
      rawInput: title,
      yearHint,
      mediaType,
      status,
      enrichmentStatus: "PENDING",
      enrichmentAttempts: 0,
      recommenderName: recommender,
      personalNotes: notes,
      sourceUrl,
      lastStatusChangeAt: iso,
      createdAt: iso,
      updatedAt: iso,
    };
    if (status === "Completed") {
      row.completedAt = iso;
      row.consumedYear = pacificYearOf(now);
    }
    row.priorityScore = computePriorityScore(
      { trustWeight: 3, criticScore: null, recommenderCount: 1, isAvailableNow: false },
      now,
    );

    await runBatch(db, [
      db.insert(mediaItems).values(row),
      db.insert(activityLog).values(logRow({ id: row.id!, title, mediaType }, now, "CREATED", null, status)),
    ]);
    return c.json(await loadItem(db, row.id!), 201);
  });

  routes.patch("/items/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const body = await readBody(c.req.raw);
    rejectUnknown(body, PATCH_FIELDS);
    if (Object.keys(body).length === 0) throw invalid("body", "no editable fields supplied");

    const cur = await loadItem(db, id);
    const now = nowFn();
    const iso = now.toISOString();
    const set: Partial<typeof mediaItems.$inferInsert> = {};
    let reset = false;

    let title = cur.title;
    if (body.title !== undefined) {
      const split = splitTitleYear(textField(body.title, "title", { max: MAX_TITLE, nonEmpty: true }));
      title = split.title;
      set.title = title;
      if (split.year !== null) {
        set.yearHint = split.year;
        reset = true;
      }
    }

    let mediaType = cur.mediaType;
    const extraLogs: LogRow[] = [];
    if (body.media_type !== undefined) {
      if (!isMediaType(body.media_type)) throw invalid("media_type", "must be one of the media types");
      if (body.media_type !== cur.mediaType) {
        mediaType = body.media_type;
        set.mediaType = mediaType;
        reset = true;
      }
    }
    if (body.personal_notes !== undefined) set.personalNotes = freeText(body.personal_notes, "personal_notes");
    if (body.personal_tier !== undefined) {
      if (body.personal_tier !== null && !isTier(body.personal_tier)) throw invalid("personal_tier", "must be S, A, B, C, D or null");
      set.personalTier = body.personal_tier;
    }
    if (body.source_url !== undefined) {
      const url = nullableUrl(body.source_url, "source_url");
      set.sourceUrl = url;
      if (url !== null && url !== cur.sourceUrl) reset = true;
    }
    if (body.year_hint !== undefined && set.yearHint === undefined) {
      const y = nullableYear(body.year_hint, "year_hint");
      set.yearHint = y;
      if (y !== null && y !== cur.yearHint) reset = true;
    }
    if (body.trust_weight !== undefined) {
      const t = body.trust_weight;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 5) throw invalid("trust_weight", "must be an integer 1 to 5");
      set.trustWeight = t;
    }
    for (const [key, prop] of EXTERNAL_ID_FIELDS) {
      if (body[key] === undefined) continue;
      const v = nullableExternalId(body[key], key);
      set[prop] = v;
      if (v !== null && v !== cur[prop]) reset = true;
    }
    if (body.review_text !== undefined) {
      const text = freeText(body.review_text, "review_text");
      set.reviewText = text;
      const done = Boolean(cur.myRating || text);
      set.reviewDone = done;
      if (!cur.reviewDone && done && text) {
        extraLogs.push(logRow({ id, title, mediaType }, now, "REVIEW_COMPLETED", null, null));
      }
    }

    if (reset) {
      set.enrichmentStatus = "PENDING";
      set.enrichmentAttempts = 0;
    }
    set.priorityScore = rescore({ ...cur, trustWeight: set.trustWeight ?? cur.trustWeight }, now);
    set.updatedAt = iso;

    const logs: LogRow[] = [];
    if (set.mediaType !== undefined) logs.push(logRow({ id, title, mediaType }, now, "TYPE_OVERRIDE", cur.mediaType, mediaType));
    logs.push(...extraLogs);

    const stmts: Stmt[] = [db.update(mediaItems).set(set).where(eq(mediaItems.id, id))];
    if (logs.length > 0) stmts.push(db.insert(activityLog).values(logs));
    await runBatch(db, stmts);
    return c.json(await loadItem(db, id));
  });

  routes.post("/items/:id/status", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const body = await readBody(c.req.raw);
    rejectUnknown(body, ["status"]);
    const target = body.status;
    if (!isStatus(target)) throw invalid("status", "must be a valid status");
    if (target === "Archived") throw invalid("status", "use DELETE to archive");

    const cur = await loadItem(db, id);
    if (cur.status === "Archived" && target !== "Backlog") {
      throw new ApiError(409, "archived", "Archived items can only be restored to Backlog.");
    }
    if (cur.status === target) return c.json(cur);

    const now = nowFn();
    const iso = now.toISOString();
    const set: Partial<typeof mediaItems.$inferInsert> = { status: target, lastStatusChangeAt: iso, updatedAt: iso };
    if (target === "Completed") {
      set.completedAt = iso;
      if (cur.consumedYear === null) set.consumedYear = pacificYearOf(now);
    }
    await runBatch(db, [
      db.update(mediaItems).set(set).where(eq(mediaItems.id, id)),
      db.insert(activityLog).values(logRow(cur, now, "STATUS_CHANGE", cur.status, target)),
    ]);
    return c.json(await loadItem(db, id));
  });

  routes.post("/items/:id/rating", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const body = await readBody(c.req.raw);
    rejectUnknown(body, ["rating", "tier", "review_text"]);
    if (!isValidRating(body.rating)) throw invalid("rating", "must be 1.0 to 5.0 in 0.5 steps");
    const rating = body.rating;
    if (body.tier !== undefined && !isTier(body.tier)) throw invalid("tier", "must be S, A, B, C or D");
    const tier = body.tier as Tier | undefined;
    const review = body.review_text === undefined ? undefined : freeText(body.review_text, "review_text");

    const cur = await loadItem(db, id);
    const now = nowFn();
    const text = review ?? cur.reviewText;
    const done = Boolean(rating || text);
    const set: Partial<typeof mediaItems.$inferInsert> = {
      myRating: rating,
      reviewDone: done,
      updatedAt: now.toISOString(),
    };
    if (tier !== undefined) set.personalTier = tier;
    if (review !== undefined) set.reviewText = review;

    const logs: LogRow[] = [
      logRow(cur, now, "RATING_LOGGED", cur.myRating === null ? null : String(cur.myRating), String(rating)),
    ];
    if (review && !cur.reviewDone && done) logs.push(logRow(cur, now, "REVIEW_COMPLETED", null, null));

    await runBatch(db, [
      db.update(mediaItems).set(set).where(eq(mediaItems.id, id)),
      db.insert(activityLog).values(logs),
    ]);
    return c.json(await loadItem(db, id));
  });

  routes.delete("/items/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const cur = await loadItem(db, id);
    if (cur.status === "Archived") return c.json(cur);
    const now = nowFn();
    const iso = now.toISOString();
    await runBatch(db, [
      db.update(mediaItems).set({ status: "Archived", lastStatusChangeAt: iso, updatedAt: iso }).where(eq(mediaItems.id, id)),
      db.insert(activityLog).values(logRow(cur, now, "STATUS_CHANGE", cur.status, "Archived")),
    ]);
    return c.json(await loadItem(db, id));
  });

  routes.get("/status", async (c) => {
    const db = drizzle(c.env.DB);
    const now = nowFn();
    const [agg, last] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)`,
          pending: sql<number>`coalesce(sum(case when ${mediaItems.enrichmentStatus} = 'PENDING' then 1 else 0 end), 0)`,
          failed: sql<number>`coalesce(sum(case when ${mediaItems.enrichmentStatus} = 'FAILED' then 1 else 0 end), 0)`,
        })
        .from(mediaItems)
        .where(ne(mediaItems.status, "Archived")),
      getCachedValue(db, LAST_INBOX_SYNC_KEY, Math.floor(now.getTime() / 1000)),
    ]);
    const row = agg[0];
    return c.json({
      lastInboxSyncAt: last,
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      total: Number(row?.total ?? 0),
    });
  });

  routes.post("/sweep", async (c) => {
    const db = drizzle(c.env.DB);
    const now = nowFn();
    let result: SweepResult;
    try {
      result = await sweep({ db, env: c.env, now: nowFn });
    } catch (e) {
      if (e instanceof GeminiError) throw new ApiError(502, "sweep_failed", "The text parser is unavailable.");
      if (e instanceof GoogleAuthError || e instanceof GoogleApiError) {
        throw new ApiError(502, "sweep_failed", "Google request failed.");
      }
      if (e instanceof SubrequestBudgetError) throw new ApiError(502, "sweep_failed", "Sweep ran out of request budget.");
      throw e;
    }
    if (!("skipped" in result) || result.skipped !== "no-inbox-doc") await recordInboxSync(db, now);
    return c.json(result);
  });

  return routes;
}

