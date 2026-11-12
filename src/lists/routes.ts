import { Hono } from "hono";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { curatedListItems, curatedLists, mediaItems } from "../db/schema";
import type { CuratedList } from "../db/schema";
import type { Db } from "../google/token";
import { GeminiError } from "../intake/gemini";
import { ApiError, invalid, isMediaType, rejectUnknown, requireObject, textField } from "../api/validate";
import type { MediaType } from "../api/validate";
import {
  DEFAULT_DRAFT_LIMIT,
  MAX_DRAFT_LIMIT,
  MAX_PROMPT,
  buildDraftPrompt,
  callGeminiDraft,
  parseGenres,
  validateDraft,
} from "./draft";
import type { Candidate } from "./draft";

export interface ListsOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

type ListsEnv = { DB: D1Database; GEMINI_API_KEY?: string; GEMINI_MODEL?: string };
type Stmt = Parameters<Db["batch"]>[0][number];

/** Carries statuses ApiError does not (503). */
class ListsError extends Error {
  constructor(
    readonly status: 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ListsError";
  }
}

export const MAX_LISTS = 100;
export const MAX_LIST_ITEMS = 100;
const MAX_SLUG = 60;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function hex(n: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return s || "list";
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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

async function loadList(db: Db, id: string): Promise<CuratedList> {
  const rows = await db.select().from(curatedLists).where(eq(curatedLists.id, id)).limit(1);
  if (!rows[0]) throw new ApiError(404, "not_found", "List not found.");
  return rows[0];
}

/** First free slug: base, base-2, base-3 ... One query for every slug starting with base. */
async function uniqueSlug(db: Db, base: string): Promise<string> {
  const rows = await db
    .select({ slug: curatedLists.slug })
    .from(curatedLists)
    .where(sql`${curatedLists.slug} LIKE ${escapeLike(base) + "%"} ESCAPE '\\'`);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function slugField(v: unknown): string {
  const s = textField(v, "slug", { max: MAX_SLUG, nonEmpty: true });
  if (!SLUG_RE.test(s)) throw invalid("slug", "must be lowercase letters, digits and single hyphens");
  return s;
}

function filterField(v: unknown): string | null {
  if (v === null) return null;
  if (!isMediaType(v)) throw invalid("media_type_filter", "must be a media type or null");
  return v;
}

function boolField(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw invalid(field, "must be a boolean");
  return v;
}

function descField(v: unknown): string {
  return textField(v, "description", { max: 2000 });
}

const LIST_FIELDS = ["title", "description", "media_type_filter", "is_public", "slug"] as const;

export function createListsRoutes(options: ListsOptions = {}) {
  const nowFn = options.now ?? (() => new Date());
  const routes = new Hono<{ Bindings: ListsEnv }>();

  routes.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof ListsError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error("lists api failed", err instanceof Error ? err.name : "unknown");
    return c.json({ error: "internal_error" }, 500);
  });

  routes.get("/lists", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select({
        id: curatedLists.id,
        slug: curatedLists.slug,
        title: curatedLists.title,
        description: curatedLists.description,
        mediaTypeFilter: curatedLists.mediaTypeFilter,
        isPublic: curatedLists.isPublic,
        createdAt: curatedLists.createdAt,
        updatedAt: curatedLists.updatedAt,
        itemCount: sql<number>`count(${curatedListItems.id})`,
      })
      .from(curatedLists)
      .leftJoin(curatedListItems, eq(curatedListItems.listId, curatedLists.id))
      .groupBy(curatedLists.id)
      .orderBy(desc(curatedLists.createdAt), desc(curatedLists.id))
      .limit(MAX_LISTS);
    return c.json({ lists: rows.map((r) => ({ ...r, itemCount: Number(r.itemCount) })) });
  });

  routes.post("/lists/draft", async (c) => {
    const db = drizzle(c.env.DB);
    const body = await readBody(c.req.raw);
    rejectUnknown(body, ["prompt", "media_type", "limit"]);
    const prompt = textField(body.prompt, "prompt", { max: MAX_PROMPT, nonEmpty: true });
    if (body.media_type !== undefined && !isMediaType(body.media_type)) {
      throw invalid("media_type", "must be one of the media types");
    }
    let limit = DEFAULT_DRAFT_LIMIT;
    if (body.limit !== undefined) {
      const l = body.limit;
      if (typeof l !== "number" || !Number.isInteger(l) || l < 1) throw invalid("limit", "must be a positive integer");
      limit = Math.min(l, MAX_DRAFT_LIMIT);
    }
    if (!c.env.GEMINI_API_KEY) throw new ListsError(503, "not_configured", "The list drafter is not configured.");

    const conds = [eq(mediaItems.status, "Completed"), ne(mediaItems.status, "Archived")];
    if (body.media_type !== undefined) conds.push(eq(mediaItems.mediaType, body.media_type as MediaType));
    const rows = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        mediaType: mediaItems.mediaType,
        releaseYear: mediaItems.releaseYear,
        creator: mediaItems.creator,
        myRating: mediaItems.myRating,
        personalTier: mediaItems.personalTier,
        genresJson: mediaItems.genresJson,
      })
      .from(mediaItems)
      .where(and(...conds))
      .orderBy(sql`${mediaItems.myRating} IS NULL`, desc(mediaItems.myRating), desc(mediaItems.completedAt), asc(mediaItems.id))
      .limit(100);
    if (rows.length === 0) throw new ApiError(422, "no_candidates", "No completed items match.");

    const candidates: Candidate[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      media_type: r.mediaType,
      release_year: r.releaseYear,
      creator: r.creator,
      my_rating: r.myRating,
      personal_tier: r.personalTier,
      genres: parseGenres(r.genresJson),
    }));

    let raw: unknown;
    try {
      raw = await callGeminiDraft({
        prompt: buildDraftPrompt(prompt, candidates, limit),
        env: c.env,
        fetchImpl: options.fetchImpl,
      });
    } catch (e) {
      if (e instanceof GeminiError) throw new ApiError(502, "draft_failed", "The list drafter is unavailable.");
      throw e;
    }
    return c.json(validateDraft(raw, candidates, limit));
  });

  routes.post("/lists", async (c) => {
    const db = drizzle(c.env.DB);
    const body = await readBody(c.req.raw);
    rejectUnknown(body, LIST_FIELDS);
    const title = textField(body.title, "title", { max: 300, nonEmpty: true });
    const description = body.description === undefined ? "" : descField(body.description);
    const filter = body.media_type_filter === undefined ? null : filterField(body.media_type_filter);
    const isPublic = body.is_public === undefined ? false : boolField(body.is_public, "is_public");

    let slug: string;
    if (body.slug !== undefined) {
      slug = slugField(body.slug);
      const clash = await db.select({ id: curatedLists.id }).from(curatedLists).where(eq(curatedLists.slug, slug)).limit(1);
      if (clash.length > 0) throw new ApiError(409, "slug_taken", "That slug is already in use.");
    } else {
      slug = await uniqueSlug(db, slugify(title));
    }

    const iso = nowFn().toISOString();
    const id = "lst_" + hex(3);
    await db.batch([
      db.insert(curatedLists).values({
        id,
        slug,
        title,
        description,
        mediaTypeFilter: filter,
        isPublic,
        createdAt: iso,
        updatedAt: iso,
      }),
    ]);
    return c.json(await loadList(db, id), 201);
  });

  routes.get("/lists/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const list = await loadList(db, c.req.param("id"));
    const items = await db
      .select({
        id: curatedListItems.id,
        media_item_id: curatedListItems.mediaItemId,
        rank: curatedListItems.rank,
        blurb: curatedListItems.blurb,
        title: mediaItems.title,
        media_type: mediaItems.mediaType,
        creator: mediaItems.creator,
        release_year: mediaItems.releaseYear,
        poster_image_url: mediaItems.posterImageUrl,
        my_rating: mediaItems.myRating,
        personal_tier: mediaItems.personalTier,
        status: mediaItems.status,
      })
      .from(curatedListItems)
      .innerJoin(mediaItems, eq(mediaItems.id, curatedListItems.mediaItemId))
      .where(eq(curatedListItems.listId, list.id))
      .orderBy(asc(curatedListItems.rank))
      .limit(MAX_LIST_ITEMS);
    return c.json({ ...list, items });
  });

  routes.patch("/lists/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const body = await readBody(c.req.raw);
    rejectUnknown(body, LIST_FIELDS);
    if (Object.keys(body).length === 0) throw invalid("body", "no editable fields supplied");
    const cur = await loadList(db, id);

    const set: Partial<typeof curatedLists.$inferInsert> = {};
    if (body.title !== undefined) set.title = textField(body.title, "title", { max: 300, nonEmpty: true });
    if (body.description !== undefined) set.description = descField(body.description);
    if (body.media_type_filter !== undefined) set.mediaTypeFilter = filterField(body.media_type_filter);
    if (body.is_public !== undefined) set.isPublic = boolField(body.is_public, "is_public");
    if (body.slug !== undefined) {
      const slug = slugField(body.slug);
      if (slug !== cur.slug) {
        const clash = await db
          .select({ id: curatedLists.id })
          .from(curatedLists)
          .where(and(eq(curatedLists.slug, slug), ne(curatedLists.id, id)))
          .limit(1);
        if (clash.length > 0) throw new ApiError(409, "slug_taken", "That slug is already in use.");
        set.slug = slug;
      }
    }
    set.updatedAt = nowFn().toISOString();
    await db.batch([db.update(curatedLists).set(set).where(eq(curatedLists.id, id))]);
    return c.json(await loadList(db, id));
  });

  routes.delete("/lists/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const cur = await loadList(db, id);
    // Children are deleted explicitly so correctness does not depend on PRAGMA foreign_keys.
    await db.batch([
      db.delete(curatedListItems).where(eq(curatedListItems.listId, id)),
      db.delete(curatedLists).where(eq(curatedLists.id, id)),
    ]);
    return c.json(cur);
  });

  routes.put("/lists/:id/items", async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const body = await readBody(c.req.raw);
    rejectUnknown(body, ["items"]);
    if (!Array.isArray(body.items)) throw invalid("items", "must be an array");
    if (body.items.length > MAX_LIST_ITEMS) throw invalid("items", `must have at most ${MAX_LIST_ITEMS} entries`);

    const entries: { mediaItemId: string; blurb: string }[] = [];
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const e of body.items) {
      const o = e as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || Array.isArray(o)) throw invalid("items", "each entry must be an object");
      rejectUnknown(o, ["media_item_id", "blurb"]);
      const mediaItemId = textField(o.media_item_id, "media_item_id", { max: 100, nonEmpty: true });
      const blurb = o.blurb === undefined ? "" : textField(o.blurb, "blurb", { max: 200 });
      if (seen.has(mediaItemId)) dupes.add(mediaItemId);
      seen.add(mediaItemId);
      entries.push({ mediaItemId, blurb });
    }
    if (dupes.size > 0) {
      throw new ApiError(422, "duplicate_items", `Duplicate media_item_id: ${[...dupes].join(", ")}`);
    }

    await loadList(db, id);

    if (entries.length > 0) {
      const ids = entries.map((e) => e.mediaItemId);
      const ok = await db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(and(inArray(mediaItems.id, ids), ne(mediaItems.status, "Archived")));
      const good = new Set(ok.map((r) => r.id));
      const bad = ids.filter((x) => !good.has(x));
      if (bad.length > 0) {
        throw new ApiError(422, "invalid_items", `Unknown or archived media_item_id: ${bad.join(", ")}`);
      }
    }

    const now = nowFn().toISOString();
    const stmts: Stmt[] = [
      db.delete(curatedListItems).where(eq(curatedListItems.listId, id)),
      // One statement per row keeps each under D1's 100 bound-parameter limit.
      ...entries.map((e, i) =>
        db.insert(curatedListItems).values({
          id: "lli_" + hex(4),
          listId: id,
          mediaItemId: e.mediaItemId,
          rank: i + 1,
          blurb: e.blurb,
          createdAt: now,
        }),
      ),
      db.update(curatedLists).set({ updatedAt: now }).where(eq(curatedLists.id, id)),
    ];
    await db.batch(stmts as [Stmt, ...Stmt[]]);
    return c.json({ items: entries.map((e, i) => ({ media_item_id: e.mediaItemId, rank: i + 1, blurb: e.blurb })) });
  });

  return routes;
}
