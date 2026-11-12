import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mediaItems } from "../db/schema";
import type { NewMediaItem } from "../db/schema";
import { seed, setup } from "../intake/test-fixtures";
import { NOW, OMDB_KEY, TMDB_KEY, movieDetails, omdbBody, routedFetch } from "../enrichment/test-fixtures";
import { jsonResponse } from "../google/test-helpers";
import { createSubrequestBudget } from "../google/api";
import { runGrooming } from "./groom";

const ENV = { TMDB_API_KEY: TMDB_KEY };
const ENV_OMDB = { TMDB_API_KEY: TMDB_KEY, OMDB_API_KEY: OMDB_KEY };

function groomable(id: string, over: Partial<NewMediaItem> = {}) {
  return { id, title: `Title ${id}`, tmdbId: id.replace(/\D/g, "") || "1", releaseState: "Upcoming" as const, ...over };
}

/** Routes /3/movie/{n} for every numeric id used, returning a fresh Streaming-state details body. */
function tmdbRoutes(ids: number[], extra: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { "www.omdbapi.com/": omdbBody, ...extra };
  for (const n of ids) r[`api.themoviedb.org/3/movie/${n}`] = movieDetails({ id: n, imdb_id: `tt${n}` });
  return r;
}

const tmdbPath = (u: string) => new URL(u).pathname;

describe("runGrooming", () => {
  it("selects by predicate, orders NULLS FIRST, only fetches by stored id", async () => {
    const { db } = setup();
    await seed(db, groomable("m10", { lastEnrichedAt: "2026-06-02T00:00:00Z" }));
    await seed(db, groomable("m11", { lastEnrichedAt: "2026-06-01T00:00:00Z", releaseState: "In_Theaters_Wide" }));
    await seed(db, groomable("m12", { lastEnrichedAt: null }));
    await seed(db, groomable("m13", { lastEnrichedAt: "2026-05-01T00:00:00Z", releaseState: "Streaming" })); // wrong state
    await seed(db, groomable("m14", { lastEnrichedAt: "2026-04-01T00:00:00Z", status: "Archived" })); // archived
    await seed(db, groomable("m15", { lastEnrichedAt: "2026-04-01T00:00:00Z", tmdbId: null })); // no id
    const f = routedFetch(tmdbRoutes([10, 11, 12]));
    const r = await runGrooming({ db, env: ENV, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(r).toEqual({ considered: 3, refreshed: 3, failed: 0 });
    expect(f.calls.map((c) => tmdbPath(c.url))).toEqual(["/3/movie/12", "/3/movie/11", "/3/movie/10"]);
    expect(f.calls.some((c) => c.url.includes("/search/"))).toBe(false);
    expect(f.calls[0]!.url).toContain("append_to_response=release_dates%2Cwatch%2Fproviders%2Ccredits");
  });

  it("refreshes derived fields and recomputes priority", async () => {
    const { db } = setup();
    await seed(db, groomable("m20", { priorityScore: 1, trustWeight: 5 }));
    const f = routedFetch(tmdbRoutes([20]));
    await runGrooming({ db, env: ENV_OMDB, fetchImpl: f.fetchImpl, now: () => NOW });
    const row = (await db.select().from(mediaItems).where(eq(mediaItems.id, "m20")))[0]!;
    expect(row.releaseState).toBe("Streaming");
    expect(row.releaseAccessDisplay).toBe("Streaming on Max");
    expect(row.streamingProvidersJson).toBe('["Max"]');
    expect(row.isAvailableNow).toBe(true);
    expect(row.imdbId).toBe("tt20");
    expect(row.criticScore).toBe(78.5);
    expect(row.priorityScore).toBeGreaterThan(1);
    expect(row.lastEnrichedAt).toBe(NOW.toISOString());
    expect(row.updatedAt).toBe(NOW.toISOString());
  });

  it("caps at 15 items", async () => {
    const { db } = setup();
    for (let i = 100; i < 120; i++) await seed(db, groomable(`m${i}`));
    const f = routedFetch(tmdbRoutes(Array.from({ length: 20 }, (_, i) => 100 + i)));
    const r = await runGrooming({ db, env: ENV, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(r.considered).toBe(15);
    expect(f.calls).toHaveLength(15);
  });

  it("never exceeds 30 subrequests, and stops early when the budget runs low", async () => {
    const { db } = setup();
    for (let i = 100; i < 120; i++) await seed(db, groomable(`m${i}`));
    const ids = Array.from({ length: 20 }, (_, i) => 100 + i);
    const f = routedFetch(tmdbRoutes(ids));
    const r = await runGrooming({ db, env: ENV_OMDB, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(r).toEqual({ considered: 15, refreshed: 15, failed: 0 });
    expect(f.calls).toHaveLength(30);

    const small = setup();
    for (let i = 100; i < 105; i++) await seed(small.db, groomable(`m${i}`));
    const f2 = routedFetch(tmdbRoutes(ids));
    const budget = createSubrequestBudget(5);
    const r2 = await runGrooming({ db: small.db, env: ENV_OMDB, fetchImpl: f2.fetchImpl, budget, now: () => NOW });
    expect(r2).toEqual({ considered: 2, refreshed: 2, failed: 0, skipped: "budget" });
    expect(f2.calls).toHaveLength(4);
  });

  it("writes everything in exactly one db.batch", async () => {
    const { d1, db } = setup();
    let batches = 0;
    const orig = (d1 as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch;
    (d1 as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch = (s) => {
      batches++;
      return orig(s);
    };
    for (let i = 100; i < 105; i++) await seed(db, groomable(`m${i}`));
    const f = routedFetch(tmdbRoutes([100, 101, 102, 103, 104]));
    await runGrooming({ db, env: ENV, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(batches).toBe(1);
  });

  it("leaves user-owned columns untouched", async () => {
    const { db } = setup();
    await seed(db, groomable("m30", {
      status: "Active",
      myRating: 4.5,
      personalTier: "A",
      personalNotes: "keep me",
      reviewText: "my review",
      enrichmentStatus: "ENRICHED",
      enrichmentAttempts: 2,
      recommenderName: "Sam",
      trustWeight: 4,
    }));
    const before = (await db.select().from(mediaItems).where(eq(mediaItems.id, "m30")))[0]!;
    const f = routedFetch(tmdbRoutes([30]));
    await runGrooming({ db, env: ENV_OMDB, fetchImpl: f.fetchImpl, now: () => NOW });
    const after = (await db.select().from(mediaItems).where(eq(mediaItems.id, "m30")))[0]!;
    for (const k of ["status", "myRating", "personalTier", "personalNotes", "reviewText", "enrichmentStatus", "enrichmentAttempts", "enrichmentError", "recommenderName", "trustWeight", "title", "mediaType"] as const) {
      expect(after[k]).toEqual(before[k]);
    }
  });

  it("counts failures, does not change enrichment_status, and keeps going", async () => {
    const { db } = setup();
    await seed(db, groomable("m40", { enrichmentStatus: "ENRICHED", lastEnrichedAt: null }));
    await seed(db, groomable("m41", { enrichmentStatus: "ENRICHED", lastEnrichedAt: "2026-06-01T00:00:00Z" }));
    await seed(db, groomable("m42", { enrichmentStatus: "ENRICHED", lastEnrichedAt: "2026-06-02T00:00:00Z" }));
    const f = routedFetch({
      ...tmdbRoutes([41]),
      "api.themoviedb.org/3/movie/40": jsonResponse({ status_message: "nf" }, 404),
      "api.themoviedb.org/3/movie/42": jsonResponse({}, 500),
    });
    const r = await runGrooming({ db, env: ENV, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(r).toEqual({ considered: 3, refreshed: 1, failed: 2 });
    const rows = await db.select().from(mediaItems);
    for (const row of rows) {
      expect(row.enrichmentStatus).toBe("ENRICHED");
      expect(row.enrichmentAttempts).toBe(0);
      expect(row.enrichmentError).toBeNull();
    }
    expect(f.calls).toHaveLength(3);
  });

  it("skips with no network call when TMDB key is missing", async () => {
    const { db } = setup();
    await seed(db, groomable("m50"));
    const f = routedFetch({});
    const r = await runGrooming({ db, env: {}, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(r).toEqual({ considered: 0, refreshed: 0, failed: 0, skipped: "no-tmdb-key" });
    expect(f.calls).toHaveLength(0);
  });
});
