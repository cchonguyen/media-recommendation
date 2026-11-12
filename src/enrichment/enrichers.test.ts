import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mediaItems, systemKv } from "../db/schema";
import { createSubrequestBudget } from "../google/api";
import { seed, setup } from "../intake/test-fixtures";
import { jsonResponse } from "../google/test-helpers";
import { booksEnricher, amazonLink } from "./books";
import { igdbEnricher, TWITCH_TOKEN_CACHE_KEY, formatHours, pickGame } from "./igdb";
import { itunesEnricher } from "./itunes";
import { findUrl, oneOffEnricher, parseOpenGraph, safeHttpUrl } from "./oneoff";
import { runEnrichmentQueue } from "./queue";
import { NOW, TMDB_KEY, movieDetails, movieSearch, routedFetch } from "./test-fixtures";
import type { EnrichContext, EnrichmentEnv } from "./types";
import type { MediaItem } from "../db/schema";

const TW_ID = "twitch-id-SECRET";
const TW_SECRET = "twitch-secret-SECRET";
const env: EnrichmentEnv = { TMDB_API_KEY: TMDB_KEY, TWITCH_CLIENT_ID: TW_ID, TWITCH_CLIENT_SECRET: TW_SECRET };
const TOKEN = "id.twitch.tv/oauth2/token";
const GAMES = "api.igdb.com/v4/games";
const BEATS = "api.igdb.com/v4/game_time_to_beats";
const unix = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

const elden = {
  id: 119133,
  name: "Elden Ring",
  first_release_date: unix("2022-02-25"),
  genres: [{ name: "RPG" }],
  involved_companies: [
    { developer: false, company: { name: "Bandai Namco" } },
    { developer: true, company: { name: "FromSoftware" } },
  ],
  cover: { image_id: "co4jni" },
  platforms: [{ name: "PC" }, { name: "PS5" }],
  total_rating: 84.4,
};
const tokenBody = { access_token: "tok1", expires_in: 3600 };
const gameRoutes = (extra: Record<string, unknown> = {}) =>
  routedFetch({ [TOKEN]: tokenBody, [GAMES]: [elden], [BEATS]: [{ normally: 43200 }], ...extra });

const row = (over: Partial<MediaItem> = {}) =>
  ({ id: "x", title: "Elden Ring", rawInput: "Elden Ring", yearHint: null, sourceUrl: null, ...over }) as MediaItem;

function ctx(db: ReturnType<typeof setup>["db"], f: { fetchImpl: typeof fetch }, r: MediaItem, e: EnrichmentEnv = env): EnrichContext {
  return { db, row: r, env: e, fetchImpl: f.fetchImpl, now: NOW };
}
const get = async (db: ReturnType<typeof setup>["db"], id: string) =>
  (await db.select().from(mediaItems).where(eq(mediaItems.id, id)))[0]!;

describe("igdb", () => {
  it("maps a game, uses the token and time to beat", async () => {
    const { db } = setup();
    const f = gameRoutes();
    const r = await igdbEnricher.enrich(ctx(db, f, row()));
    expect(r).toEqual({
      kind: "ok",
      fields: {
        igdbId: "119133",
        releaseYear: 2022,
        releaseDate: "2022-02-25",
        releaseState: "Published",
        genresJson: '["RPG"]',
        creator: "FromSoftware",
        posterImageUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big/co4jni.jpg",
        criticScore: 84.4,
        criticScoreDisplay: "IGDB 84",
        timeCommitmentMinutes: 720,
        timeCommitmentDisplay: "~12 h",
        categoryMetadataJson: '{"platforms":["PC","PS5"]}',
      },
    });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]!.headers).toMatchObject({ "client-id": TW_ID, authorization: "Bearer tok1" });
    expect(f.calls[1]!.body).toContain('search "Elden Ring"');
    expect(f.calls[2]!.body).toContain("where game_id = 119133");
  });

  it("marks future games Upcoming and survives a failing time-to-beat call", async () => {
    const { db } = setup();
    const f = gameRoutes({ [GAMES]: [{ ...elden, first_release_date: unix("2027-01-01") }], [BEATS]: new Response("no", { status: 500 }) });
    const r = await igdbEnricher.enrich(ctx(db, f, row()));
    expect(r).toMatchObject({ kind: "ok", fields: { releaseState: "Upcoming", timeCommitmentMinutes: null, timeCommitmentDisplay: "" } });
  });

  it("returns not-found for zero results without a beats call", async () => {
    const { db } = setup();
    const f = gameRoutes({ [GAMES]: [] });
    expect(await igdbEnricher.enrich(ctx(db, f, row()))).toEqual({ kind: "not-found" });
    expect(f.calls).toHaveLength(2);
  });

  it("picks exact title, then year hint, else most recent; formats hours", () => {
    const g = [
      { id: 1, name: "Doom", first_release_date: unix("1993-12-10") },
      { id: 2, name: "Doom", first_release_date: unix("2016-05-13") },
      { id: 3, name: "Doom Eternal", first_release_date: unix("2020-03-20") },
    ];
    expect(pickGame(g, "doom", null)!.id).toBe(2);
    expect(pickGame(g, "doom", 1993)!.id).toBe(1);
    expect(pickGame(g, "nope", null)!.id).toBe(3);
    expect(pickGame([], "x", null)).toBeUndefined();
    expect(formatHours(45)).toBe("~45 min");
  });

  it("caches the Twitch token in system_kv, reuses it, and refreshes after expiry", async () => {
    const { db } = setup();
    const f = gameRoutes();
    await igdbEnricher.enrich(ctx(db, f, row()));
    const kv = (await db.select().from(systemKv).where(eq(systemKv.key, TWITCH_TOKEN_CACHE_KEY)))[0]!;
    expect(kv.value).toBe("tok1");
    expect(kv.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 3600 - 300);
    const tokenCalls = () => f.calls.filter((c) => c.url.includes("oauth2/token")).length;
    expect(tokenCalls()).toBe(1);

    await igdbEnricher.enrich(ctx(db, f, row()));
    expect(tokenCalls()).toBe(1); // reused

    const later = { ...ctx(db, f, row()), now: new Date(NOW.getTime() + 3600 * 1000) };
    await igdbEnricher.enrich(later);
    expect(tokenCalls()).toBe(2); // expired, refreshed
  });

  it("fails without leaking secrets when the token request is rejected", async () => {
    const { db } = setup();
    const f = gameRoutes({ [TOKEN]: new Response("bad", { status: 403 }) });
    const err = await igdbEnricher.enrich(ctx(db, f, row())).catch((e: Error) => e);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain(TW_SECRET);
  });

  it("needs both Twitch keys", () => {
    expect(igdbEnricher.hasCredentials({})).toBe(false);
    expect(igdbEnricher.hasCredentials({ TWITCH_CLIENT_ID: "a" })).toBe(false);
    expect(igdbEnricher.hasCredentials(env)).toBe(true);
  });
});

const BOOKS = "www.googleapis.com/books/v1/volumes";
const volume = (over: Record<string, unknown> = {}) => ({
  volumeInfo: {
    title: "Project Hail Mary",
    authors: ["Andy Weir", "Co Author"],
    publishedDate: "2021-05-04",
    pageCount: 476,
    categories: ["Fiction"],
    industryIdentifiers: [
      { type: "ISBN_10", identifier: "0593135202" },
      { type: "ISBN_13", identifier: "9780593135204" },
    ],
    imageLinks: { thumbnail: "http://books.google.com/cover.jpg" },
    ...over,
  },
});

describe("books", () => {
  const r0 = row({ title: "Project Hail Mary" });
  it("maps a volume with an ISBN-based Amazon link", async () => {
    const { db } = setup();
    const f = routedFetch({ [BOOKS]: { items: [volume()] } });
    const r = await booksEnricher.enrich(ctx(db, f, r0));
    expect(r).toEqual({
      kind: "ok",
      fields: {
        isbn13: "9780593135204",
        creator: "Andy Weir, Co Author",
        releaseYear: 2021,
        releaseDate: "2021-05-04",
        releaseState: "Published",
        genresJson: '["Fiction"]',
        timeCommitmentDisplay: "476 pages",
        timeCommitmentMinutes: 952,
        posterImageUrl: "https://books.google.com/cover.jpg",
        amazonLink: "https://www.amazon.com/s?k=9780593135204",
      },
    });
    expect(new URL(f.calls[0]!.url).searchParams.get("q")).toBe("intitle:Project Hail Mary");
    expect(new URL(f.calls[0]!.url).searchParams.has("key")).toBe(false);
  });

  it("falls back to the encoded title without an ISBN, sends the optional key, handles year-only dates", async () => {
    const { db } = setup();
    const f = routedFetch({ [BOOKS]: { items: [volume({ industryIdentifiers: [], publishedDate: "2031", pageCount: undefined })] } });
    const r = await booksEnricher.enrich(ctx(db, f, r0, { ...env, GOOGLE_BOOKS_API_KEY: "bk" }));
    expect(r).toMatchObject({ kind: "ok", fields: { isbn13: null, amazonLink: "https://www.amazon.com/s?k=Project%20Hail%20Mary", releaseDate: null, releaseState: "Upcoming", timeCommitmentDisplay: "" } });
    expect(new URL(f.calls[0]!.url).searchParams.get("key")).toBe("bk");
    expect(amazonLink(null, "A & B")).toBe("https://www.amazon.com/s?k=A%20%26%20B");
  });

  it("returns not-found, and errors omit the key", async () => {
    const { db } = setup();
    const none = routedFetch({ [BOOKS]: { totalItems: 0 } });
    expect(await booksEnricher.enrich(ctx(db, none, r0))).toEqual({ kind: "not-found" });
    const bad = routedFetch({ [BOOKS]: new Response("x", { status: 429 }) });
    const err = await booksEnricher.enrich(ctx(db, bad, r0, { ...env, GOOGLE_BOOKS_API_KEY: "bk-SECRET" })).catch((e: Error) => e);
    expect((err as Error).message).toContain("429");
    expect((err as Error).message).not.toContain("bk-SECRET");
    expect(booksEnricher.hasCredentials({})).toBe(true);
  });
});

describe("itunes", () => {
  const pod = { collectionId: 1200361736, collectionName: "The Daily", artistName: "The New York Times", feedUrl: "https://feeds.example/daily", trackCount: 2000, artworkUrl600: "https://img/600.jpg", genres: ["News", "Podcasts"] };
  it("maps a podcast preferring the exact name", async () => {
    const { db } = setup();
    const f = routedFetch({ "itunes.apple.com/search": { results: [{ ...pod, collectionId: 5, collectionName: "Daily Other" }, pod] } });
    const r = await itunesEnricher.enrich(ctx(db, f, row({ title: "The Daily" })));
    expect(r).toEqual({
      kind: "ok",
      fields: {
        itunesId: "1200361736",
        creator: "The New York Times",
        genresJson: '["News"]',
        timeCommitmentDisplay: "2000 episodes",
        posterImageUrl: "https://img/600.jpg",
        categoryMetadataJson: '{"feedUrl":"https://feeds.example/daily"}',
        releaseState: "Published",
      },
    });
    const u = new URL(f.calls[0]!.url);
    expect([u.searchParams.get("media"), u.searchParams.get("entity"), u.searchParams.get("limit")]).toEqual(["podcast", "podcast", "5"]);
  });
  it("returns not-found", async () => {
    const { db } = setup();
    const f = routedFetch({ "itunes.apple.com/search": { results: [] } });
    expect(await itunesEnricher.enrich(ctx(db, f, row({ title: "Nope" })))).toEqual({ kind: "not-found" });
  });
});

describe("one-off", () => {
  const html = `<html><head><meta property="og:title" content="A &amp; B"><meta content="https://img/og.png" property="og:image"><meta property="og:site_name" content="Example Mag"><meta property="og:description" content="${"d".repeat(400)}"></head></html>`;
  const oneOff = (over: Partial<MediaItem> = {}) => row({ title: "Great essay", rawInput: "Great essay https://example.com/post", ...over });

  it("parses OpenGraph from a page and sets source_url", async () => {
    const { db } = setup();
    const f = routedFetch({ "example.com/post": new Response(html, { status: 200 }) });
    const r = await oneOffEnricher.enrich(ctx(db, f, oneOff()));
    expect(r).toMatchObject({ kind: "ok", fields: { sourceUrl: "https://example.com/post", creator: "Example Mag", posterImageUrl: "https://img/og.png", releaseState: "Published" } });
    const meta = JSON.parse((r as { fields: { categoryMetadataJson: string } }).fields.categoryMetadataJson);
    expect(meta).toMatchObject({ site: "Example Mag", title: "A & B" });
    expect(meta.description).toHaveLength(300);
  });

  it("caps the body it reads", async () => {
    const { db } = setup();
    const big = new Response(`<meta property="og:site_name" content="Early">${"x".repeat(200_000)}<meta property="og:image" content="late">`);
    const f = routedFetch({ "example.com/post": big });
    const r = await oneOffEnricher.enrich(ctx(db, f, oneOff()));
    expect(r).toMatchObject({ fields: { creator: "Early", posterImageUrl: "" } });
  });

  it("uses YouTube oEmbed", async () => {
    const { db } = setup();
    const f = routedFetch({ "www.youtube.com/oembed": { title: "Talk", author_name: "Chan", thumbnail_url: "https://i.ytimg.com/t.jpg" } });
    const r = await oneOffEnricher.enrich(ctx(db, f, oneOff({ rawInput: "x", sourceUrl: "https://youtu.be/abc" })));
    expect(r).toMatchObject({ kind: "ok", fields: { sourceUrl: "https://youtu.be/abc", creator: "Chan", posterImageUrl: "https://i.ytimg.com/t.jpg" } });
    expect(new URL(f.calls[0]!.url).searchParams.get("url")).toBe("https://youtu.be/abc");
    expect(new URL(f.calls[0]!.url).searchParams.get("format")).toBe("json");
  });

  it("makes no network call for plain text", async () => {
    const { db } = setup();
    const f = routedFetch({});
    const r = await oneOffEnricher.enrich(ctx(db, f, oneOff({ rawInput: "Think about X", title: "Think about X" })));
    expect(r).toEqual({ kind: "ok", fields: { releaseState: "Published" } });
    expect(f.calls).toHaveLength(0);
  });

  it("still succeeds on non-200 and on network errors", async () => {
    const { db } = setup();
    const f404 = routedFetch({ "example.com/post": new Response("no", { status: 404 }) });
    expect(await oneOffEnricher.enrich(ctx(db, f404, oneOff()))).toMatchObject({ kind: "ok", fields: { sourceUrl: "https://example.com/post" } });
    const boom = { fetchImpl: (async () => { throw new Error("net"); }) as typeof fetch };
    expect(await oneOffEnricher.enrich(ctx(db, boom, oneOff()))).toMatchObject({ kind: "ok", fields: { sourceUrl: "https://example.com/post" } });
  });

  it("rejects non-http schemes and private hosts without any fetch", async () => {
    const { db } = setup();
    const hosts = ["http://localhost/a", "http://127.0.0.1/a", "http://10.1.2.3/a", "http://192.168.1.1/a", "http://169.254.169.254/latest", "http://172.16.0.1/a", "http://172.31.255.1/a", "http://[::1]/a", "ftp://example.com/a", "file:///etc/passwd", "http://0.0.0.0/"];
    for (const h of hosts) {
      expect(safeHttpUrl(h), h).toBeNull();
      const f = routedFetch({});
      const r = await oneOffEnricher.enrich(ctx(db, f, oneOff({ rawInput: `see ${h}`, sourceUrl: h })));
      expect(f.calls, h).toHaveLength(0);
      expect(r.kind).toBe("ok");
      expect((r as { fields: object }).fields).not.toHaveProperty("sourceUrl");
    }
    expect(safeHttpUrl("http://172.32.0.1/")).not.toBeNull();
    expect(safeHttpUrl("https://example.com/")).not.toBeNull();
  });

  it("finds URLs and parses OpenGraph helpers", () => {
    expect(findUrl({ sourceUrl: null, rawInput: "a https://x.io/p?q=1 b" })).toBe("https://x.io/p?q=1");
    expect(findUrl({ sourceUrl: null, rawInput: "none" })).toBeNull();
    expect(parseOpenGraph("<meta name='og:title' content='T'>").title).toBe("T");
  });
});

describe("queue with all enrichers", () => {
  const f = () =>
    routedFetch({
      "api.themoviedb.org/3/search/movie": movieSearch({ id: 438631, title: "Dune", release_date: "2021-10-22" }),
      "api.themoviedb.org/3/movie/438631": movieDetails(),
      [TOKEN]: tokenBody,
      [GAMES]: [elden],
      [BEATS]: [{ normally: 43200 }],
      [BOOKS]: { items: [volume()] },
      "itunes.apple.com/search": { results: [{ collectionId: 7, collectionName: "Pod", artistName: "Host", trackCount: 3 }] },
      "example.com/x": new Response(`<meta property="og:site_name" content="Ex">`),
    });
  const run = (db: ReturnType<typeof setup>["db"], ff: { fetchImpl: typeof fetch }, extra: object = {}, e: EnrichmentEnv = env) =>
    runEnrichmentQueue({ db, env: e, fetchImpl: ff.fetchImpl, now: () => NOW, ...extra });

  async function seedMixed(db: ReturnType<typeof setup>["db"]) {
    await seed(db, { id: "m", title: "Dune", mediaType: "Movie", createdAt: "2026-01-01T00:00:00.000Z" });
    await seed(db, { id: "g", title: "Elden Ring", mediaType: "Game", createdAt: "2026-01-02T00:00:00.000Z" });
    await seed(db, { id: "b", title: "Project Hail Mary", mediaType: "Book", createdAt: "2026-01-03T00:00:00.000Z" });
    await seed(db, { id: "p", title: "Pod", mediaType: "Podcast", createdAt: "2026-01-04T00:00:00.000Z" });
    await seed(db, { id: "o", title: "Essay", rawInput: "Essay https://example.com/x", mediaType: "One-Off", createdAt: "2026-01-05T00:00:00.000Z" });
  }

  it("enriches a mixed batch in one run, within budget, with one db.batch", async () => {
    const { db } = setup();
    await seedMixed(db);
    const budget = createSubrequestBudget(50);
    const spy = vi.spyOn(db, "batch");
    const s = await run(db, f(), { budget });
    expect(s).toEqual({ processed: 5, enriched: 5, failed: 0, merged: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(2 + 3 + 1 + 1 + 1);
    for (const id of ["m", "g", "b", "p", "o"]) expect(await get(db, id)).toMatchObject({ enrichmentStatus: "ENRICHED", enrichmentError: null, lastEnrichedAt: NOW.toISOString() });
    expect(await get(db, "g")).toMatchObject({ igdbId: "119133", criticScore: 84.4 });
    expect(await get(db, "b")).toMatchObject({ isbn13: "9780593135204", amazonLink: "https://www.amazon.com/s?k=9780593135204" });
    expect(await get(db, "p")).toMatchObject({ itunesId: "7", timeCommitmentDisplay: "3 episodes" });
    expect(await get(db, "o")).toMatchObject({ sourceUrl: "https://example.com/x", creator: "Ex" });
  });

  it("skips Game without Twitch keys and burns no attempts, while others proceed", async () => {
    const { db } = setup();
    await seedMixed(db);
    const ff = f();
    const s = await run(db, ff, {}, { TMDB_API_KEY: TMDB_KEY });
    expect(s).toMatchObject({ processed: 4, enriched: 4, failed: 0 });
    expect(ff.calls.some((c) => c.url.includes("igdb") || c.url.includes("twitch"))).toBe(false);
    expect(await get(db, "g")).toMatchObject({ enrichmentStatus: "PENDING", enrichmentAttempts: 0 });
  });

  it("without any keys only keyless types run and Movie waits unharmed", async () => {
    const { db } = setup();
    await seedMixed(db);
    const s = await run(db, f(), {}, {});
    expect(s).toMatchObject({ processed: 3, enriched: 3 });
    expect(await get(db, "m")).toMatchObject({ enrichmentAttempts: 0, enrichmentStatus: "PENDING" });
  });

  it("redacts Twitch secrets from stored errors", async () => {
    const { db } = setup();
    await seed(db, { id: "g", title: "Elden Ring", mediaType: "Game" });
    const ff = routedFetch({ [TOKEN]: () => { throw new Error(`boom ${TW_SECRET}`); } });
    await run(db, ff);
    const r = await get(db, "g");
    expect(r.enrichmentAttempts).toBe(1);
    expect(r.enrichmentError).toContain("[redacted]");
    expect(r.enrichmentError).not.toContain(TW_SECRET);
  });
});

describe("Stage 2 merge on igdb_id, isbn13, itunes_id", () => {
  const cases = [
    { type: "Game" as const, col: "igdbId" as const, val: "119133", title: "Elden Ring" },
    { type: "Book" as const, col: "isbn13" as const, val: "9780593135204", title: "Project Hail Mary" },
    { type: "Podcast" as const, col: "itunesId" as const, val: "7", title: "Pod" },
  ];
  for (const c of cases) {
    it(`folds a newer duplicate on ${c.col}`, async () => {
      const { db } = setup();
      await seed(db, { id: "old", title: c.title, mediaType: c.type, [c.col]: c.val, enrichmentStatus: "ENRICHED", createdAt: "2026-01-01T00:00:00.000Z", recommenderName: "A", trustWeight: 4 });
      await seed(db, { id: "new", title: `${c.title} dup`, mediaType: c.type, createdAt: "2026-02-01T00:00:00.000Z", recommenderName: "B" });
      const ff = routedFetch({
        [TOKEN]: tokenBody,
        [GAMES]: [elden],
        [BEATS]: [],
        [BOOKS]: { items: [volume()] },
        "itunes.apple.com/search": { results: [{ collectionId: 7, collectionName: "Pod" }] },
      });
      const s = await runEnrichmentQueue({ db, env, fetchImpl: ff.fetchImpl, now: () => NOW });
      expect(s).toMatchObject({ enriched: 1, merged: 1 });
      const rows = await db.select().from(mediaItems);
      expect(rows.map((r) => r.id)).toEqual(["old"]);
      expect(rows[0]).toMatchObject({ recommenderName: "A, B", recommenderCount: 2, trustWeight: 4, [c.col]: c.val });
    });
  }
});
