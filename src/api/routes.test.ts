import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { activityLog, mediaItems, sweepRuns, systemKv } from "../db/schema";
import { GoogleApiError } from "../google/api";
import { GeminiError } from "../intake/gemini";
import { seed, setup } from "../intake/test-fixtures";
import { createApiRoutes } from "./routes";
import type { ApiOptions } from "./routes";
import { eq } from "drizzle-orm";

// 2026-03-09T03:30:00Z is Sunday 20:30 PDT (DST began 2026-03-08), still the previous UTC-vs-Pacific day.
const NOW = new Date("2026-03-09T03:30:00Z");

function harness(opts: ApiOptions = {}) {
  const { d1, db } = setup();
  const batch = vi.spyOn(d1, "batch");
  const app = new Hono();
  app.route("/api", createApiRoutes({ now: () => NOW, ...opts }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      path,
      { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      { DB: d1 },
    );
    return { status: res.status, json: (await res.json()) as any };
  };
  const logs = (id: string) => db.select().from(activityLog).where(eq(activityLog.itemId, id));
  const row = async (id: string) => (await db.select().from(mediaItems).where(eq(mediaItems.id, id)))[0]!;
  return { d1, db, batch, call, logs, row };
}

describe("create", () => {
  it("creates an item, logs CREATED with Pacific day/hour, one batch", async () => {
    const h = harness();
    const r = await h.call("POST", "/api/items", { title: "Dune", media_type: "Movie" });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^itm_[0-9a-f]{8}$/);
    expect(r.json).toMatchObject({
      title: "Dune",
      rawInput: "Dune",
      status: "Backlog",
      recommenderName: "Self",
      enrichmentStatus: "PENDING",
      createdAt: NOW.toISOString(),
      lastStatusChangeAt: NOW.toISOString(),
    });
    expect(h.batch).toHaveBeenCalledTimes(1);
    const logs = await h.logs(r.json.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      eventType: "CREATED",
      itemTitleSnapshot: "Dune",
      mediaType: "Movie",
      dayOfWeekPt: 0,
      hourOfDayPt: 20,
    });
  });

  it("parses a year suffix into year_hint", async () => {
    const h = harness();
    const r = await h.call("POST", "/api/items", { title: "Dune (2021)", media_type: "Movie", year_hint: 1984 });
    expect(r.json.title).toBe("Dune");
    expect(r.json.yearHint).toBe(2021);
  });

  it("accepts optional fields and rejects bad input", async () => {
    const h = harness();
    const ok = await h.call("POST", "/api/items", {
      title: "X",
      media_type: "Book",
      status: "Up Next",
      recommender_name: "Justin",
      personal_notes: "n",
      source_url: "https://example.com/x",
    });
    expect(ok.json).toMatchObject({ status: "Up Next", recommenderName: "Justin", personalNotes: "n", sourceUrl: "https://example.com/x" });
    expect((await h.call("POST", "/api/items", { media_type: "Book" })).status).toBe(422);
    expect((await h.call("POST", "/api/items", { title: "X", media_type: "Film" })).status).toBe(422);
    expect((await h.call("POST", "/api/items", { title: "X", media_type: "Book", status: "Archived" })).status).toBe(422);
    expect((await h.call("POST", "/api/items", { title: "X", media_type: "Book", source_url: "javascript:1" })).status).toBe(422);
    expect((await h.call("POST", "/api/items", { title: "X", media_type: "Book", bogus: 1 })).status).toBe(422);
  });

  it("rejects non-JSON and non-object bodies with 400", async () => {
    const h = harness();
    const res = await new Hono().route("/api", createApiRoutes()).request(
      "/api/items",
      { method: "POST", body: "nope" },
      { DB: h.d1 },
    );
    expect(res.status).toBe(400);
    expect((await h.call("POST", "/api/items", [1])).status).toBe(400);
  });
});

describe("list and get", () => {
  async function seeded() {
    const h = harness();
    await seed(h.db, { id: "itm_00000001", title: "Alpha", mediaType: "Movie", priorityScore: 10, releaseYear: 2000 });
    await seed(h.db, { id: "itm_00000002", title: "Bravo", mediaType: "Book", priorityScore: 90, releaseYear: 2010 });
    await seed(h.db, { id: "itm_00000003", title: "Charlie 100%", mediaType: "Movie", priorityScore: 50, status: "Completed" });
    await seed(h.db, { id: "itm_00000004", title: "Delta", mediaType: "Movie", priorityScore: 99, status: "Archived" });
    return h;
  }

  it("excludes Archived by default, includes when asked", async () => {
    const h = await seeded();
    const all = await h.call("GET", "/api/items");
    expect(all.json.total).toBe(3);
    expect(all.json.items.map((i: any) => i.title)).toEqual(["Bravo", "Charlie 100%", "Alpha"]);
    const arch = await h.call("GET", "/api/items?status=Archived");
    expect(arch.json.items.map((i: any) => i.title)).toEqual(["Delta"]);
  });

  it("filters by type, status and q (escaping LIKE wildcards)", async () => {
    const h = await seeded();
    expect((await h.call("GET", "/api/items?type=Book")).json.total).toBe(1);
    expect((await h.call("GET", "/api/items?status=Completed")).json.items).toHaveLength(1);
    expect((await h.call("GET", "/api/items?q=alp")).json.items[0].title).toBe("Alpha");
    expect((await h.call("GET", "/api/items?q=100%25")).json.items).toHaveLength(1);
    expect((await h.call("GET", "/api/items?q=%25")).json.total).toBe(1);
    expect((await h.call("GET", "/api/items?q=_lpha")).json.total).toBe(0);
    expect((await h.call("GET", "/api/items?type=Nope")).status).toBe(400);
    expect((await h.call("GET", "/api/items?status=Nope")).status).toBe(400);
  });

  it("sorts on whitelisted columns only", async () => {
    const h = await seeded();
    const asc = await h.call("GET", "/api/items?sort=title&order=asc");
    expect(asc.json.items.map((i: any) => i.title)).toEqual(["Alpha", "Bravo", "Charlie 100%"]);
    const yr = await h.call("GET", "/api/items?sort=release_year&order=desc");
    expect(yr.json.items[0].title).toBe("Bravo");
    expect((await h.call("GET", "/api/items?sort=raw_input")).status).toBe(400);
    expect((await h.call("GET", "/api/items?sort=title;drop")).status).toBe(400);
    expect((await h.call("GET", "/api/items?sort=toString")).status).toBe(400);
    expect((await h.call("GET", "/api/items?order=sideways")).status).toBe(400);
  });

  it("pages with limit/offset and caps limit at 100", async () => {
    const h = await seeded();
    const p1 = await h.call("GET", "/api/items?limit=2&offset=0");
    const p2 = await h.call("GET", "/api/items?limit=2&offset=2");
    expect(p1.json.items).toHaveLength(2);
    expect(p2.json.items).toHaveLength(1);
    expect(p1.json.total).toBe(3);
    expect(p2.json.items[0].title).toBe("Alpha");
    expect((await h.call("GET", "/api/items?limit=1000")).json.items).toHaveLength(3);
    expect((await h.call("GET", "/api/items?limit=abc")).status).toBe(400);
    expect((await h.call("GET", "/api/items?limit=0")).status).toBe(400);
    expect((await h.call("GET", "/api/items?offset=-1")).status).toBe(400);
    // cap check against real volume
    for (let i = 0; i < 105; i++) await seed(h.db, { id: `itm_1000${String(i).padStart(4, "0")}`, title: `Bulk ${i}` });
    const capped = await h.call("GET", "/api/items?limit=1000");
    expect(capped.json.items).toHaveLength(100);
    expect(capped.json.total).toBe(108);
    expect((await h.call("GET", "/api/items")).json.items).toHaveLength(50);
  });

  it("gets one item or 404", async () => {
    const h = await seeded();
    expect((await h.call("GET", "/api/items/itm_00000001")).json.title).toBe("Alpha");
    expect((await h.call("GET", "/api/items/itm_nope")).status).toBe(404);
  });
});

describe("status transitions", () => {
  it.each(["Backlog", "Up Next", "Active", "Paused", "Abandoned"] as const)("moves to %s with a STATUS_CHANGE log", async (target) => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T", status: target === "Backlog" ? "Active" : "Backlog" });
    const r = await h.call("POST", "/api/items/itm_a/status", { status: target });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe(target);
    expect(r.json.lastStatusChangeAt).toBe(NOW.toISOString());
    expect(r.json.completedAt).toBeNull();
    expect(h.batch).toHaveBeenCalledTimes(1);
    const logs = await h.logs("itm_a");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      eventType: "STATUS_CHANGE",
      newValue: target,
      dayOfWeekPt: 0,
      hourOfDayPt: 20,
      itemTitleSnapshot: "T",
      mediaType: "Movie",
    });
  });

  it("Completed sets completed_at and Pacific consumed_year, keeps existing consumed_year, history survives leaving", async () => {
    const h = harness();
    // 2027-01-01T05:00Z is still 2026 in Pacific.
    const nowNy = new Date("2027-01-01T05:00:00Z");
    const h2 = harness({ now: () => nowNy });
    await seed(h2.db, { id: "itm_a", title: "T" });
    const r = await h2.call("POST", "/api/items/itm_a/status", { status: "Completed" });
    expect(r.json.consumedYear).toBe(2026);
    expect(r.json.completedAt).toBe(nowNy.toISOString());

    await seed(h.db, { id: "itm_b", title: "B", consumedYear: 2019 });
    const r2 = await h.call("POST", "/api/items/itm_b/status", { status: "Completed" });
    expect(r2.json.consumedYear).toBe(2019);
    const back = await h.call("POST", "/api/items/itm_b/status", { status: "Active" });
    expect(back.json.completedAt).toBe(NOW.toISOString());
    expect(back.json.consumedYear).toBe(2019);
  });

  it("validates enum, rejects Archived, 404, no-op on same status", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T" });
    expect((await h.call("POST", "/api/items/itm_a/status", { status: "Nope" })).status).toBe(422);
    expect((await h.call("POST", "/api/items/itm_a/status", {})).status).toBe(422);
    expect((await h.call("POST", "/api/items/itm_a/status", { status: "Archived" })).status).toBe(422);
    expect((await h.call("POST", "/api/items/itm_zz/status", { status: "Active" })).status).toBe(404);
    const same = await h.call("POST", "/api/items/itm_a/status", { status: "Backlog" });
    expect(same.status).toBe(200);
    expect(h.batch).not.toHaveBeenCalled();
    expect(await h.logs("itm_a")).toHaveLength(0);
  });

  it("Abandoned only on explicit request: no other route sets it", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T", status: "Paused", lastStatusChangeAt: "2020-01-01T00:00:00.000Z" });
    await h.call("PATCH", "/api/items/itm_a", { personal_notes: "x" });
    await h.call("POST", "/api/items/itm_a/rating", { rating: 3 });
    await h.call("GET", "/api/status");
    expect((await h.row("itm_a")).status).toBe("Paused");
    const r = await h.call("POST", "/api/items/itm_a/status", { status: "Abandoned" });
    expect(r.json.status).toBe("Abandoned");
  });

  it("409 for Archived rows except restore to Backlog", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T", status: "Archived" });
    const r = await h.call("POST", "/api/items/itm_a/status", { status: "Active" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("archived");
    const ok = await h.call("POST", "/api/items/itm_a/status", { status: "Backlog" });
    expect(ok.json.status).toBe("Backlog");
    expect((await h.logs("itm_a"))[0]).toMatchObject({ oldValue: "Archived", newValue: "Backlog" });
  });
});

describe("rating", () => {
  it("validates 0.5 steps and bounds", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T" });
    for (const bad of [0, 0.5, 5.5, 3.3, "4", null, NaN, 6]) {
      expect((await h.call("POST", "/api/items/itm_a/rating", { rating: bad })).status).toBe(422);
    }
    expect((await h.call("POST", "/api/items/itm_a/rating", {})).status).toBe(422);
    expect((await h.call("POST", "/api/items/itm_a/rating", { rating: 3, tier: "Z" })).status).toBe(422);
    expect((await h.call("POST", "/api/items/itm_zz/rating", { rating: 3 })).status).toBe(404);
    expect(h.batch).not.toHaveBeenCalled();
    for (const good of [1, 1.5, 4.5, 5]) {
      expect((await h.call("POST", "/api/items/itm_a/rating", { rating: good })).json.myRating).toBe(good);
    }
  });

  it("sets rating, tier, review, review_done, logs RATING_LOGGED and REVIEW_COMPLETED in one batch", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T", status: "Completed" });
    const r = await h.call("POST", "/api/items/itm_a/rating", { rating: 4.5, tier: "A", review_text: "Great" });
    expect(r.json).toMatchObject({ myRating: 4.5, personalTier: "A", reviewText: "Great", reviewDone: true });
    expect(h.batch).toHaveBeenCalledTimes(1);
    const logs = await h.logs("itm_a");
    expect(logs.map((l) => l.eventType)).toEqual(["RATING_LOGGED", "REVIEW_COMPLETED"]);
    expect(logs[0]).toMatchObject({ oldValue: null, newValue: "4.5", dayOfWeekPt: 0, hourOfDayPt: 20 });
  });

  it("rating alone flips review_done but writes no REVIEW_COMPLETED; re-rating does not repeat it", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T" });
    const r = await h.call("POST", "/api/items/itm_a/rating", { rating: 3 });
    expect(r.json.reviewDone).toBe(true);
    expect((await h.logs("itm_a")).map((l) => l.eventType)).toEqual(["RATING_LOGGED"]);
    await h.call("POST", "/api/items/itm_a/rating", { rating: 4, review_text: "later" });
    const types = (await h.logs("itm_a")).map((l) => l.eventType);
    expect(types).toEqual(["RATING_LOGGED", "RATING_LOGGED"]);
    expect((await h.logs("itm_a"))[1]).toMatchObject({ oldValue: "3", newValue: "4" });
  });
});

describe("patch and invariant 7", () => {
  async function enriched(h: ReturnType<typeof harness>) {
    await seed(h.db, {
      id: "itm_a",
      title: "Dune",
      enrichmentStatus: "ENRICHED",
      enrichmentAttempts: 3,
      priorityScore: 1,
    });
  }

  it("type change resets enrichment and logs TYPE_OVERRIDE", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { media_type: "Book" });
    expect(r.json).toMatchObject({ mediaType: "Book", enrichmentStatus: "PENDING", enrichmentAttempts: 0 });
    expect(h.batch).toHaveBeenCalledTimes(1);
    const logs = await h.logs("itm_a");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ eventType: "TYPE_OVERRIDE", oldValue: "Movie", newValue: "Book", mediaType: "Book", dayOfWeekPt: 0, hourOfDayPt: 20 });
  });

  it("same type does not reset or log", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { media_type: "Movie", personal_notes: "hi" });
    expect(r.json).toMatchObject({ enrichmentStatus: "ENRICHED", enrichmentAttempts: 3, personalNotes: "hi" });
    expect(await h.logs("itm_a")).toHaveLength(0);
  });

  it("year in title strips the suffix, sets year_hint, resets", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { title: "Dune (2021)" });
    expect(r.json).toMatchObject({ title: "Dune", yearHint: 2021, enrichmentStatus: "PENDING", enrichmentAttempts: 0 });
  });

  it("plain title edit does not reset", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { title: "Dune: Part One" });
    expect(r.json).toMatchObject({ title: "Dune: Part One", enrichmentStatus: "ENRICHED" });
  });

  it.each([
    ["tmdb_id", "438631"],
    ["imdb_id", "tt1160419"],
    ["igdb_id", "123"],
    ["isbn13", "9780441013593"],
    ["itunes_id", "555"],
    ["source_url", "https://example.com/dune"],
  ])("supplying %s resets enrichment", async (field, value) => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { [field]: value });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enrichmentStatus: "PENDING", enrichmentAttempts: 0 });
  });

  it("clearing an external id does not reset; numeric ids are coerced", async () => {
    const h = harness();
    await enriched(h);
    await h.d1.prepare("UPDATE media_items SET tmdb_id='1' WHERE id='itm_a'").run();
    const r = await h.call("PATCH", "/api/items/itm_a", { tmdb_id: null });
    expect(r.json).toMatchObject({ tmdbId: null, enrichmentStatus: "ENRICHED" });
    const r2 = await h.call("PATCH", "/api/items/itm_a", { tmdb_id: 42 });
    expect(r2.json.tmdbId).toBe("42");
  });

  it("recomputes priority_score on trust change", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { trust_weight: 5 });
    // 50 trust + 21 default critic points
    expect(r.json.priorityScore).toBe(71);
  });

  it("review_text edit sets review_done and logs REVIEW_COMPLETED once", async () => {
    const h = harness();
    await enriched(h);
    const r = await h.call("PATCH", "/api/items/itm_a", { review_text: "ok", personal_tier: "B" });
    expect(r.json).toMatchObject({ reviewDone: true, personalTier: "B" });
    expect((await h.logs("itm_a")).map((l) => l.eventType)).toEqual(["REVIEW_COMPLETED"]);
  });

  it("validates fields, 404, unknown, empty", async () => {
    const h = harness();
    await enriched(h);
    for (const body of [
      { media_type: "Film" },
      { title: "" },
      { personal_tier: "Z" },
      { year_hint: 12 },
      { trust_weight: 9 },
      { source_url: "ftp://x" },
      { status: "Abandoned" },
      { priority_score: 1 },
      {},
    ]) {
      expect((await h.call("PATCH", "/api/items/itm_a", body)).status).toBe(422);
    }
    expect((await h.call("PATCH", "/api/items/itm_zz", { title: "x" })).status).toBe(404);
    expect(h.batch).not.toHaveBeenCalled();
  });
});

describe("soft archive", () => {
  it("archives without deleting the row or its log", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T", status: "Active" });
    const r = await h.call("DELETE", "/api/items/itm_a");
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("Archived");
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect((await h.row("itm_a")).status).toBe("Archived");
    const logs = await h.logs("itm_a");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ eventType: "STATUS_CHANGE", oldValue: "Active", newValue: "Archived" });
    expect((await h.call("GET", "/api/items")).json.total).toBe(0);
    expect((await h.call("DELETE", "/api/items/itm_zz")).status).toBe(404);
    // idempotent
    expect((await h.call("DELETE", "/api/items/itm_a")).status).toBe(200);
    expect(h.batch).toHaveBeenCalledTimes(1);
  });
});

describe("batch usage", () => {
  it("every mutation performs exactly one db.batch", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T" });
    const calls: [string, string, unknown?][] = [
      ["POST", "/api/items", { title: "N", media_type: "TV" }],
      ["PATCH", "/api/items/itm_a", { media_type: "Game", review_text: "r" }],
      ["POST", "/api/items/itm_a/status", { status: "Completed" }],
      ["POST", "/api/items/itm_a/rating", { rating: 2, review_text: "z" }],
      ["DELETE", "/api/items/itm_a"],
    ];
    for (const [m, p, b] of calls) {
      h.batch.mockClear();
      const r = await h.call(m, p, b);
      expect(r.status).toBeLessThan(300);
      expect(h.batch).toHaveBeenCalledTimes(1);
    }
  });

  it("a failing batch leaves no partial write", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_a", title: "T" });
    await h.d1.prepare("CREATE TRIGGER boom BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'x'); END").run();
    const r = await h.call("POST", "/api/items/itm_a/status", { status: "Active" });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "internal_error" });
    expect((await h.row("itm_a")).status).toBe("Backlog");
  });
});

describe("status endpoint", () => {
  it("counts non-archived items and reads last_inbox_sync", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_1", title: "a" });
    await seed(h.db, { id: "itm_2", title: "b", enrichmentStatus: "FAILED" });
    await seed(h.db, { id: "itm_3", title: "c", enrichmentStatus: "ENRICHED" });
    await seed(h.db, { id: "itm_4", title: "d", status: "Archived", enrichmentStatus: "FAILED" });
    const none = await h.call("GET", "/api/status");
    expect(none.json).toEqual({ lastInboxSyncAt: null, pending: 1, failed: 1, total: 3 });
    await h.db.insert(systemKv).values({ key: "last_inbox_sync", value: "2026-03-01T00:00:00.000Z", expiresAt: 4102444800 });
    expect((await h.call("GET", "/api/status")).json.lastInboxSyncAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("is zero on an empty table", async () => {
    const h = harness();
    expect((await h.call("GET", "/api/status")).json).toEqual({ lastInboxSyncAt: null, pending: 0, failed: 0, total: 0 });
  });
});

describe("sweep", () => {
  it("runs the injected sweep, returns its result, records last_inbox_sync", async () => {
    const result = { skipped: "nothing-to-do" as const, remainingInDoc: 0 as const };
    const sweep = vi.fn().mockResolvedValue(result);
    const h = harness({ sweep });
    const r = await h.call("POST", "/api/sweep");
    expect(r.status).toBe(200);
    expect(r.json).toEqual(result);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect((await h.call("GET", "/api/status")).json.lastInboxSyncAt).toBe(NOW.toISOString());
  });

  it("does not record when no inbox doc is configured", async () => {
    const h = harness({ sweep: async () => ({ skipped: "no-inbox-doc" as const }) });
    expect((await h.call("POST", "/api/sweep")).status).toBe(200);
    expect((await h.call("GET", "/api/status")).json.lastInboxSyncAt).toBeNull();
  });

  it.each([
    ["Gemini", () => new GeminiError("key sk-SECRET leaked", 500)],
    ["Google", () => new GoogleApiError("token SECRET-TOKEN", 500)],
  ])("returns 502 with a safe message on %s errors", async (_n, make) => {
    const h = harness({ sweep: async () => { throw make(); } });
    const r = await h.call("POST", "/api/sweep");
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("sweep_failed");
    expect(JSON.stringify(r.json)).not.toContain("SECRET");
    expect((await h.call("GET", "/api/status")).json.lastInboxSyncAt).toBeNull();
  });

  it("shows Gemini's status and reason on a failed sweep", async () => {
    const h = harness({ sweep: async () => { throw new GeminiError("Gemini request failed", 429, "Quota exceeded"); } });
    const r = await h.call("POST", "/api/sweep");
    expect(r.json.message).toBe("The text parser is unavailable (Gemini HTTP 429: Quota exceeded).");
  });

  it("returns 500 without details for unexpected errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ sweep: async () => { throw new Error("SECRET"); } });
    const r = await h.call("POST", "/api/sweep");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("SECRET");
    spy.mockRestore();
  });
});

describe("sweeps ledger and test parse", () => {
  it("GET /api/sweeps returns the newest 20 rows", async () => {
    const h = harness();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      startedAt: `2026-03-09T00:${String(i).padStart(2, "0")}:00Z`,
      durationMs: 10,
      trigger: "button" as const,
      outcome: "ok" as const,
    }));
    await h.db.insert(sweepRuns).values(rows);
    const r = await h.call("GET", "/api/sweeps");
    expect(r.status).toBe(200);
    expect(r.json.sweeps).toHaveLength(20);
    expect(r.json.sweeps[0]).toMatchObject({ id: 25, startedAt: "2026-03-09T00:24:00Z", linesSeen: 0, keptInDoc: 0 });
  });

  it("POST /api/sweep/test-parse returns the injected result", async () => {
    const result = { lines: [{ line: "Dune", ok: true, title: "Dune" }] };
    const testParse = vi.fn().mockResolvedValue(result);
    const h = harness({ testParse });
    const r = await h.call("POST", "/api/sweep/test-parse");
    expect(r.status).toBe(200);
    expect(r.json).toEqual(result);
    expect(testParse).toHaveBeenCalledTimes(1);
  });

  it("maps Google and Gemini errors to 502", async () => {
    for (const make of [() => new GoogleApiError("docs", 500), () => new GeminiError("Gemini request failed", 429, "Quota")]) {
      const h = harness({ testParse: async () => { throw make(); } });
      const r = await h.call("POST", "/api/sweep/test-parse");
      expect(r.status).toBe(502);
      expect(r.json.error).toBe("test_parse_failed");
    }
  });
});
