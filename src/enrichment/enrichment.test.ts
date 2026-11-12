import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, curatedListItems, curatedLists, mediaItems } from "../db/schema";
import { createSubrequestBudget } from "../google/api";
import { seed, setup } from "../intake/test-fixtures";
import { jsonResponse } from "../google/test-helpers";
import { computePriorityScore } from "./priority";
import { deriveMovieReleaseState, deriveTvReleaseState, fetchTmdbMetadata, pickSearchHit } from "./tmdb";
import { fetchOmdbRatings, parseOmdbRatings } from "./omdb";
import { mergeRows, orderByAge } from "./merge";
import { MAX_ITEMS_PER_RUN, runEnrichmentQueue } from "./queue";
import { NOW, OMDB_KEY, TMDB_KEY, movieDetails, movieSearch, omdbBody, routedFetch } from "./test-fixtures";
import type { Enricher } from "./types";

const TMDB = "api.themoviedb.org/3";
const dune = { id: 438631, title: "Dune", release_date: "2021-10-22" };

describe("computePriorityScore", () => {
  const base = { trustWeight: 3, criticScore: null, recommenderCount: 1, isAvailableNow: false };
  it("matches spec values", () => {
    expect(computePriorityScore(base, NOW)).toBe(51); // 30 + 21
    expect(computePriorityScore({ ...base, trustWeight: 5, criticScore: 90, recommenderCount: 3 }, NOW)).toBe(87); // 50+27+10
    expect(computePriorityScore({ ...base, trustWeight: 5, criticScore: 100, recommenderCount: 9, isAvailableNow: true, releaseDate: "2026-06-01" }, NOW)).toBe(100);
    expect(computePriorityScore({ ...base, criticScore: 83.3 }, NOW)).toBe(55); // 30 + 24.99 -> 54.99 -> 55
  });
  it("gives recency only when available now and within 365 days", () => {
    const a = { ...base, isAvailableNow: true };
    expect(computePriorityScore({ ...a, releaseDate: "2026-01-01" }, NOW)).toBe(61);
    expect(computePriorityScore({ ...a, releaseDate: "2025-06-01" }, NOW)).toBe(51);
    expect(computePriorityScore({ ...a, releaseDate: "2027-01-01" }, NOW)).toBe(51);
    expect(computePriorityScore({ ...a, releaseYear: 2025 }, NOW)).toBe(61);
    expect(computePriorityScore({ ...base, releaseDate: "2026-06-01" }, NOW)).toBe(51);
  });
  it("clamps to 0..100", () => {
    expect(computePriorityScore({ trustWeight: -50, criticScore: 0, recommenderCount: 1, isAvailableNow: false }, NOW)).toBe(0);
    expect(computePriorityScore({ trustWeight: 50, criticScore: 100, recommenderCount: 1, isAvailableNow: false }, NOW)).toBe(100);
  });
});

describe("release state", () => {
  const us = (type: number, date: string) => ({ type, release_date: `${date}T00:00:00.000Z` });
  const st = (usReleases: ReturnType<typeof us>[], hasFlatrate = false, releaseDate: string | null = null) =>
    deriveMovieReleaseState({ usReleases, releaseDate, hasFlatrate, now: NOW });
  it("movie cases", () => {
    expect(st([us(3, "2026-08-01")])).toBe("Upcoming");
    expect(st([us(2, "2026-08-01")])).toBe("Upcoming");
    expect(st([], false, "2026-09-01")).toBe("Upcoming");
    expect(st([us(3, "2026-06-01")])).toBe("In_Theaters_Wide");
    expect(st([us(2, "2026-06-01")])).toBe("In_Theaters_Limited");
    expect(st([us(2, "2026-06-01"), us(3, "2026-06-20")])).toBe("In_Theaters_Wide");
    expect(st([us(3, "2026-06-01")], true)).toBe("Streaming");
    expect(st([us(3, "2026-01-01")], true)).toBe("Streaming");
    expect(st([us(3, "2026-01-01")])).toBe("Published");
    expect(st([us(4, "2026-06-20")])).toBe("Published");
    expect(st([us(3, "2026-05-01")])).toBe("Published"); // 61 days ago
  });
  it("tv cases", () => {
    expect(deriveTvReleaseState({ status: "Returning Series" })).toBe("Ongoing_TV");
    expect(deriveTvReleaseState({ status: "Ended" })).toBe("Ended_TV");
    expect(deriveTvReleaseState({ status: "Canceled", in_production: true })).toBe("Ended_TV");
    expect(deriveTvReleaseState({ status: "Planned", in_production: true })).toBe("Ongoing_TV");
  });
});

describe("tmdb adapter", () => {
  const args = { mediaType: "Movie" as const, title: "Dune", apiKey: TMDB_KEY, now: NOW };

  it("maps a movie", async () => {
    const f = routedFetch({
      [`${TMDB}/search/movie`]: movieSearch(dune),
      [`${TMDB}/movie/438631`]: movieDetails(),
    });
    const r = await fetchTmdbMetadata({ ...args, yearHint: null, fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({
      kind: "ok",
      fields: {
        tmdbId: "438631",
        imdbId: "tt1160419",
        releaseYear: 2021,
        releaseDate: "2021-10-22",
        creator: "Denis Villeneuve",
        timeCommitmentMinutes: 155,
        timeCommitmentDisplay: "2h 35m",
        posterImageUrl: "https://image.tmdb.org/t/p/w500/dune.jpg",
        streamingProvidersJson: '["Max"]',
        genresJson: '["Science Fiction","Adventure"]',
        releaseState: "Streaming",
        releaseAccessDisplay: "Streaming on Max",
        isAvailableNow: true,
      },
    });
    expect(f.calls[1]!.url).toContain("append_to_response=release_dates%2Cwatch%2Fproviders%2Ccredits");
  });

  it("maps TV with imdb from external_ids", async () => {
    const f = routedFetch({
      [`${TMDB}/search/tv`]: movieSearch({ id: 1, name: "Severance", first_air_date: "2022-02-18" }),
      [`${TMDB}/tv/1`]: {
        id: 1,
        name: "Severance",
        first_air_date: "2022-02-18",
        status: "Returning Series",
        number_of_seasons: 2,
        episode_run_time: [50],
        created_by: [{ name: "Dan Erickson" }],
        external_ids: { imdb_id: "tt11280740" },
        poster_path: "/s.jpg",
        genres: [{ name: "Drama" }],
      },
    });
    const r = await fetchTmdbMetadata({ ...args, mediaType: "TV", title: "Severance", yearHint: null, fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({
      kind: "ok",
      fields: { imdbId: "tt11280740", creator: "Dan Erickson", timeCommitmentDisplay: "2 seasons", timeCommitmentMinutes: 50, releaseState: "Ongoing_TV", isAvailableNow: false },
    });
  });

  it("uses the year hint in the search and picks the most recent exact match otherwise", async () => {
    const hits = [
      { id: 1, title: "Dune", release_date: "1984-12-14" },
      { id: 2, title: "Dune", release_date: "2021-10-22" },
      { id: 3, title: "Dune: Part Two", release_date: "2024-03-01" },
    ];
    expect(pickSearchHit(hits, "dune")!.id).toBe(2);
    expect(pickSearchHit(hits, "Nope")!.id).toBe(3);
    expect(pickSearchHit([], "x")).toBeUndefined();

    const f = routedFetch({
      [`${TMDB}/search/movie`]: movieSearch(hits[0]!),
      [`${TMDB}/movie/1`]: movieDetails({ id: 1, release_date: "1984-12-14" }),
    });
    await fetchTmdbMetadata({ ...args, yearHint: 1984, fetchImpl: f.fetchImpl });
    expect(new URL(f.calls[0]!.url).searchParams.get("year")).toBe("1984");
    const tv = routedFetch({ [`${TMDB}/search/tv`]: movieSearch() });
    await fetchTmdbMetadata({ ...args, mediaType: "TV", yearHint: 2020, fetchImpl: tv.fetchImpl });
    expect(new URL(tv.calls[0]!.url).searchParams.get("first_air_date_year")).toBe("2020");
  });

  it("returns not-found for zero results without a details call", async () => {
    const f = routedFetch({ [`${TMDB}/search/movie`]: movieSearch() });
    expect(await fetchTmdbMetadata({ ...args, yearHint: null, fetchImpl: f.fetchImpl })).toEqual({ kind: "not-found" });
    expect(f.calls).toHaveLength(1);
  });

  it("keeps the api key out of error messages", async () => {
    const f = routedFetch({ [`${TMDB}/search/movie`]: new Response("no", { status: 401 }) });
    const err = await fetchTmdbMetadata({ ...args, yearHint: null, fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(TMDB_KEY);
  });
});

describe("omdb adapter", () => {
  it("averages RT and MC", () => {
    expect(parseOmdbRatings(omdbBody)).toEqual({ criticScore: 78.5, criticScoreDisplay: "RT 83% · MC 74" });
  });
  it("falls back to imdb rating then empty", () => {
    expect(parseOmdbRatings({ imdbRating: "7.5", Ratings: [] })).toEqual({ criticScore: 75, criticScoreDisplay: "IMDb 7.5" });
    expect(parseOmdbRatings({ imdbRating: "N/A" })).toEqual({ criticScore: null, criticScoreDisplay: "" });
  });
  it("never throws on missing key, HTTP error or network error", async () => {
    const empty = { criticScore: null, criticScoreDisplay: "" };
    expect(await fetchOmdbRatings({ imdbId: "tt1", apiKey: undefined })).toEqual(empty);
    const bad = routedFetch({ "www.omdbapi.com/": new Response("x", { status: 500 }) });
    expect(await fetchOmdbRatings({ imdbId: "tt1", apiKey: OMDB_KEY, fetchImpl: bad.fetchImpl })).toEqual(empty);
    const boom = (async () => {
      throw new Error("net");
    }) as typeof fetch;
    expect(await fetchOmdbRatings({ imdbId: "tt1", apiKey: OMDB_KEY, fetchImpl: boom })).toEqual(empty);
  });
});

function happyRoutes(extra: Record<string, unknown> = {}) {
  return routedFetch({
    [`${TMDB}/search/movie`]: movieSearch(dune),
    [`${TMDB}/movie/438631`]: movieDetails(),
    "www.omdbapi.com/": omdbBody,
    ...extra,
  });
}
const env = { TMDB_API_KEY: TMDB_KEY, OMDB_API_KEY: OMDB_KEY };
const run = (db: ReturnType<typeof setup>["db"], f: { fetchImpl: typeof fetch }, extra: object = {}) =>
  runEnrichmentQueue({ db, env, fetchImpl: f.fetchImpl, now: () => NOW, ...extra });
const get = async (db: ReturnType<typeof setup>["db"], id: string) =>
  (await db.select().from(mediaItems).where(eq(mediaItems.id, id)))[0];

describe("runEnrichmentQueue", () => {
  it("enriches a movie with critic data and priority", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune", trustWeight: 5 });
    const f = happyRoutes();
    expect(await run(db, f)).toEqual({ processed: 1, enriched: 1, failed: 0, merged: 0 });
    const r = (await get(db, "a"))!;
    expect(r).toMatchObject({
      enrichmentStatus: "ENRICHED",
      enrichmentError: null,
      tmdbId: "438631",
      criticScore: 78.5,
      criticScoreDisplay: "RT 83% · MC 74",
      lastEnrichedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      priorityScore: 73.6, // 50 + 78.5*0.3
    });
    expect(JSON.stringify(f.calls)).toBeTruthy();
  });

  it("OMDb failure or missing key still ENRICHES with null critic", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune" });
    const f = happyRoutes({ "www.omdbapi.com/": new Response("x", { status: 500 }) });
    await run(db, f);
    expect(await get(db, "a")).toMatchObject({ enrichmentStatus: "ENRICHED", criticScore: null, criticScoreDisplay: "" });

    const { db: db2 } = setup();
    await seed(db2, { id: "b", title: "Dune" });
    const f2 = happyRoutes();
    await runEnrichmentQueue({ db: db2, env: { TMDB_API_KEY: TMDB_KEY }, fetchImpl: f2.fetchImpl, now: () => NOW });
    expect(await get(db2, "b")).toMatchObject({ enrichmentStatus: "ENRICHED", criticScore: null });
    expect(f2.calls.some((c) => c.url.includes("omdbapi"))).toBe(false);
  });

  it("processes oldest first, capped at 10, skipping attempts>=3, non-PENDING and unregistered types", async () => {
    const { db } = setup();
    for (let i = 0; i < 12; i++) {
      await seed(db, { id: `m${String(i).padStart(2, "0")}`, title: `T${i}`, createdAt: `2026-01-${String(20 - i).padStart(2, "0")}T00:00:00.000Z` });
    }
    await seed(db, { id: "tired", title: "Tired", enrichmentAttempts: 3, createdAt: "2020-01-01T00:00:00.000Z" });
    await seed(db, { id: "book", title: "A Book", mediaType: "Book", createdAt: "2020-01-01T00:00:00.000Z" });
    await seed(db, { id: "done", title: "Done", enrichmentStatus: "ENRICHED", createdAt: "2020-01-01T00:00:00.000Z" });
    const seen: string[] = [];
    const f = routedFetch({
      [`${TMDB}/search/movie`]: (u: URL) => {
        seen.push(u.searchParams.get("query")!);
        return jsonResponse(movieSearch());
      },
    });
    const s = await runEnrichmentQueue({ db, env: { TMDB_API_KEY: TMDB_KEY }, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(MAX_ITEMS_PER_RUN).toBe(10);
    expect(s).toMatchObject({ processed: 10, failed: 10 });
    // m11 is oldest (Jan 9) ... m02 is the 10th oldest; m00 and m01 are left.
    expect(seen).toEqual(["T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2"]);
    expect((await get(db, "book"))!.enrichmentAttempts).toBe(0);
    expect((await get(db, "tired"))!.enrichmentAttempts).toBe(3);
    expect((await get(db, "m00"))!.enrichmentAttempts).toBe(0);
  });

  it("increments attempts on failure and sets FAILED on the third", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Nothing" });
    const f = routedFetch({ [`${TMDB}/search/movie`]: movieSearch() });
    await run(db, f);
    expect(await get(db, "a")).toMatchObject({ enrichmentAttempts: 1, enrichmentStatus: "PENDING", enrichmentError: "No match found" });
    await run(db, f);
    expect(await get(db, "a")).toMatchObject({ enrichmentAttempts: 2, enrichmentStatus: "PENDING" });
    const s = await run(db, f);
    expect(s.failed).toBe(1);
    expect(await get(db, "a")).toMatchObject({ enrichmentAttempts: 3, enrichmentStatus: "FAILED" });
    expect((await run(db, f)).processed).toBe(0);
  });

  it("records HTTP errors without leaking keys", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune" });
    const f = routedFetch({
      [`${TMDB}/search/movie`]: () => {
        throw new Error(`boom ${TMDB_KEY}`);
      },
    });
    await run(db, f);
    const r = (await get(db, "a"))!;
    expect(r.enrichmentAttempts).toBe(1);
    expect(r.enrichmentError).toContain("[redacted]");
    expect(r.enrichmentError).not.toContain(TMDB_KEY);
  });

  it("returns early without a TMDB key and burns no attempts", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune" });
    const f = happyRoutes();
    const s = await runEnrichmentQueue({ db, env: {}, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(s).toEqual({ processed: 0, enriched: 0, failed: 0, merged: 0, skipped: "no-tmdb-key" });
    expect(f.calls).toHaveLength(0);
    expect((await get(db, "a"))!.enrichmentAttempts).toBe(0);
  });

  it("stops before exceeding the subrequest budget", async () => {
    const { db } = setup();
    for (const id of ["a", "b", "c"]) await seed(db, { id, title: `T${id}`, createdAt: `2026-01-0${id.charCodeAt(0) - 96}T00:00:00.000Z` });
    const f = routedFetch({
      [`${TMDB}/search/movie`]: movieSearch(dune),
      [`${TMDB}/movie/438631`]: movieDetails(),
      "www.omdbapi.com/": omdbBody,
    });
    const budget = createSubrequestBudget(5); // 3 needed per item with an OMDb key
    const s = await run(db, f, { budget });
    expect(s.processed).toBe(1);
    expect(s.skipped).toBe("budget");
    expect(budget.used).toBeLessThanOrEqual(5);
    expect((await get(db, "b"))!.enrichmentAttempts).toBe(0);
  });

  it("writes everything in a single db.batch", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune", createdAt: "2026-01-01T00:00:00.000Z" });
    await seed(db, { id: "b", title: "Dune (again)", createdAt: "2026-01-02T00:00:00.000Z" });
    await seed(db, { id: "c", title: "Other", createdAt: "2026-01-03T00:00:00.000Z" });
    const f = routedFetch({
      [`${TMDB}/search/movie`]: (u: URL) => jsonResponse(movieSearch(u.searchParams.get("query") === "Other" ? { id: 9, title: "Other" } : dune)),
      [`${TMDB}/movie/438631`]: movieDetails(),
      [`${TMDB}/movie/9`]: movieDetails({ id: 9, imdb_id: null }),
    });
    const spy = vi.spyOn(db, "batch");
    const s = await run(db, f);
    expect(s).toMatchObject({ enriched: 3, merged: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("makes no batch call when nothing is pending", async () => {
    const { db } = setup();
    const spy = vi.spyOn(db, "batch");
    await run(db, happyRoutes());
    expect(spy).not.toHaveBeenCalled();
  });

  it("only handles registered types and offers a registration override", async () => {
    const { db } = setup();
    await seed(db, { id: "g", title: "Game", mediaType: "Game" });
    const fake: Enricher = {
      subrequestsNeeded: () => 1,
      hasCredentials: () => true,
      enrich: async () => ({ kind: "ok", fields: { creator: "Studio" } }),
    };
    const s = await runEnrichmentQueue({ db, env, now: () => NOW, enrichers: new Map([["Game", fake]]) });
    expect(s.enriched).toBe(1);
    expect(await get(db, "g")).toMatchObject({ enrichmentStatus: "ENRICHED", creator: "Studio" });
  });
});

describe("Stage 2 canonical merge", () => {
  async function seedMerge() {
    const { db } = setup();
    // The existing, older, already enriched row.
    await seed(db, {
      id: "old",
      title: "Dune",
      createdAt: "2026-01-01T00:00:00.000Z",
      tmdbId: "438631",
      enrichmentStatus: "ENRICHED",
      recommenderName: "Justin",
      trustWeight: 5,
      personalNotes: "from justin",
      myRating: 4.5,
      status: "Completed",
      releaseDate: "2021-10-22",
      releaseYear: 2021,
    });
    // The newer row that is about to gain the same tmdb_id.
    await seed(db, {
      id: "new",
      title: "Dune 2021",
      yearHint: 2021,
      createdAt: "2026-02-01T00:00:00.000Z",
      recommenderName: "justin, Ana",
      recommenderCount: 2,
      trustWeight: 2,
      personalNotes: "from ana",
      alternativeMatchesNote: "maybe 1984",
    });
    await db.insert(activityLog).values({ itemId: "new", itemTitleSnapshot: "Dune 2021", mediaType: "Movie", eventType: "CREATED", dayOfWeekPt: 1, hourOfDayPt: 1, createdAt: "2026-02-01T00:00:00.000Z" });
    await db.insert(curatedLists).values({ id: "lst_1", slug: "s", title: "L", createdAt: "x", updatedAt: "x" });
    await db.insert(curatedListItems).values({ id: "cli_1", listId: "lst_1", mediaItemId: "new", rank: 1, createdAt: "x" });
    return db;
  }

  it("folds the newer duplicate into the older survivor", async () => {
    const db = await seedMerge();
    const s = await run(db, happyRoutes());
    expect(s).toMatchObject({ enriched: 1, merged: 1 });
    expect(await get(db, "new")).toBeUndefined();
    const r = (await get(db, "old"))!;
    expect(r).toMatchObject({
      recommenderName: "Justin, Ana",
      recommenderCount: 2,
      trustWeight: 5,
      myRating: 4.5,
      status: "Completed",
      title: "Dune",
      enrichmentStatus: "ENRICHED",
      alternativeMatchesNote: "maybe 1984",
    });
    expect(r.personalNotes).toBe("from justin | from ana");
    expect(r.priorityScore).toBe(76); // trust 50 + null critic 21 + 2 recommenders 5
    const acts = await db.select().from(activityLog);
    expect(acts.filter((a) => a.itemId === "old").map((a) => a.eventType).sort()).toEqual(["CANONICAL_MERGE", "CREATED"]);
    expect(acts.some((a) => a.itemId === "new")).toBe(false);
    const merge = acts.find((a) => a.eventType === "CANONICAL_MERGE")!;
    expect(merge).toMatchObject({ oldValue: "new", newValue: "old", createdAt: NOW.toISOString() });
    expect((await db.select().from(curatedListItems))[0]!.mediaItemId).toBe("old");
  });

  it("makes the older row the survivor even when it is the one being enriched", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune", createdAt: "2026-01-01T00:00:00.000Z", recommenderName: "Self" });
    await seed(db, { id: "b", title: "Dune", yearHint: 2021, createdAt: "2026-01-02T00:00:00.000Z", recommenderName: "Bo", tmdbId: "438631", enrichmentStatus: "ENRICHED" });
    const s = await run(db, happyRoutes());
    expect(s.merged).toBe(1);
    expect(await get(db, "b")).toBeUndefined();
    expect(await get(db, "a")).toMatchObject({ recommenderName: "Self, Bo", recommenderCount: 2, enrichmentStatus: "ENRICHED", tmdbId: "438631" });
  });

  it("merges two rows enriched in the same run", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune", createdAt: "2026-01-01T00:00:00.000Z", recommenderName: "A" });
    await seed(db, { id: "b", title: "Dune!", createdAt: "2026-01-02T00:00:00.000Z", recommenderName: "B" });
    const s = await run(db, happyRoutes());
    expect(s).toMatchObject({ enriched: 2, merged: 1 });
    expect(await get(db, "b")).toBeUndefined();
    expect(await get(db, "a")).toMatchObject({ recommenderName: "A, B", recommenderCount: 2 });
  });

  it("does not merge across media types", async () => {
    const { db } = setup();
    await seed(db, { id: "a", title: "Dune", mediaType: "TV", tmdbId: "438631", enrichmentStatus: "ENRICHED" });
    await seed(db, { id: "b", title: "Dune" });
    expect((await run(db, happyRoutes())).merged).toBe(0);
    expect(await get(db, "a")).toBeDefined();
  });

  it("mergeRows fills missing personal fields and breaks age ties by id", () => {
    const mk = (id: string, over: object) =>
      ({ id, title: "T", createdAt: "x", recommenderName: "A", trustWeight: 3, personalNotes: "", alternativeMatchesNote: "", myRating: null, personalTier: null, reviewText: "", reviewDone: false, consumedYear: null, completedAt: null, enrichmentStatus: "PENDING", criticScore: null, isAvailableNow: false, releaseDate: null, releaseYear: null, ...over }) as never;
    const [s, d] = orderByAge(mk("b", {}), mk("a", {}));
    expect([s.id, d.id]).toEqual(["a", "b"]);
    const m = mergeRows(mk("a", { myRating: 3 }), mk("b", { myRating: 5, personalTier: "S", reviewText: "great", reviewDone: true, consumedYear: 2024 }), NOW);
    expect(m).toMatchObject({ myRating: 3, personalTier: "S", reviewText: "great", reviewDone: true, consumedYear: 2024 });
  });
});
