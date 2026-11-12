import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, intakeLog, mediaItems } from "../db/schema";
import { createSubrequestBudget } from "../google/api";
import { jsonResponse } from "../google/test-helpers";
import { MAX_LINES_PER_RUN, hashLine, normalizeLine, splitLines } from "./lines";
import { pacificDayAndHour } from "./pacific";
import { GEMINI_RETRY_DELAYS_MS, GeminiError, parseLinesWithGemini, validateGeminiItems } from "./gemini";
import { ingestRawLines, unionNames } from "./ingest";
import { FIXED_NOW, GEMINI_KEY, echoGemini, geminiBody, geminiFetch, item, seed, setup } from "./test-fixtures";

const env = { GEMINI_API_KEY: GEMINI_KEY };

function deps(db: ReturnType<typeof setup>["db"], fetchImpl: typeof fetch) {
  return { db, env, fetchImpl, now: () => FIXED_NOW };
}

describe("lines", () => {
  it("normalises, hashes case/space-insensitively, and splits", async () => {
    expect(normalizeLine("  Dune  ")).toBe("dune");
    expect(await hashLine("  DUNE ")).toBe(await hashLine("dune"));
    expect(await hashLine("dune")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashLine("dune")).not.toBe(await hashLine("dune 2"));
    expect(splitLines("a\r\n\n  b  \n \nc")).toEqual(["a", "b", "c"]);
    expect(MAX_LINES_PER_RUN).toBe(25);
  });
});

describe("pacificDayAndHour", () => {
  it("handles PDT, PST and a UTC-date-crossing evening", () => {
    expect(pacificDayAndHour(new Date("2026-07-01T19:00:00Z"))).toEqual({ dayOfWeekPt: 3, hourOfDayPt: 12 });
    expect(pacificDayAndHour(new Date("2026-12-01T19:00:00Z"))).toEqual({ dayOfWeekPt: 2, hourOfDayPt: 11 });
    expect(pacificDayAndHour(new Date("2026-07-02T03:30:00Z"))).toEqual({ dayOfWeekPt: 3, hourOfDayPt: 20 });
    expect(pacificDayAndHour(new Date("2026-07-01T07:30:00Z"))).toEqual({ dayOfWeekPt: 3, hourOfDayPt: 0 });
  });
});

describe("validateGeminiItems", () => {
  it("keeps good items and drops bad ones", () => {
    const { items, rejected } = validateGeminiItems(
      {
        items: [
          item({ trustWeight: 9, myRating: 4.5, yearHint: 2021 }),
          item({ title: "   " }),
          item({ title: "x".repeat(301) }),
          item({ mediaType: "Concert" }),
          item({ myRating: 4.3 }),
          item({ myRating: 6 }),
          item({ yearHint: 1700 }),
          item({ consumedYear: 2.5 }),
          item({ personalNotes: "n".repeat(2001) }),
          item({ lineIndex: 5 }),
          item({ lineIndex: -1 }),
          null,
          item({ trustWeight: "high", title: "Ok Two" }),
        ],
      },
      2,
    );
    expect(items.map((i) => i.title)).toEqual(["Dune", "Ok Two"]);
    expect(items[0]!.trustWeight).toBe(5);
    expect(items[1]!.trustWeight).toBe(3);
    expect(rejected).toBe(11);
  });

  it("returns nothing for a malformed envelope", () => {
    expect(validateGeminiItems({ nope: 1 }, 3)).toEqual({ items: [], rejected: 0 });
  });
});

describe("unionNames", () => {
  it("dedupes case-insensitively keeping first casing", () => {
    expect(unionNames(["Alex"], ["alex"])).toEqual(["Alex"]);
    expect(unionNames(["Alex"], ["Justin"])).toEqual(["Alex", "Justin"]);
  });
});

describe("ingestRawLines", () => {
  it("inserts rows with the right fields and logs CREATED with Pacific time", async () => {
    const { db } = setup();
    const f = geminiFetch(() =>
      geminiBody([
        item({ lineIndex: 0, title: "Dune", yearHint: 2021, recommenderName: "justin", trustWeight: 3, personalNotes: "epic" }),
        item({ lineIndex: 1, title: "Severance", mediaType: "TV", isAlreadyConsumed: true, myRating: 5, consumedYear: 2025, alternativeMatchesNote: "also 2006 show" }),
        item({ lineIndex: 0, title: "Hyperion", mediaType: "Book" }),
      ]),
    );
    const budget = createSubrequestBudget();
    const res = await ingestRawLines({ ...deps(db, f.fetchImpl), budget }, ["Dune 2021 from Justin", "watched Severance 5 stars", "buy milk", "  "], "webhook");

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(budget.used).toBe(1);
    expect(res).toMatchObject({ accepted: 3, merged: 0, created: 3, skippedDuplicates: 0, rejected: 0, remaining: 0, unparsedLines: ["buy milk"] });

    const rows = await db.select().from(mediaItems);
    expect(rows).toHaveLength(3);
    const dune = rows.find((r) => r.title === "Dune")!;
    expect(dune).toMatchObject({
      status: "Backlog", enrichmentStatus: "PENDING", yearHint: 2021, rawInput: "Dune 2021 from Justin",
      recommenderName: "justin", recommenderCount: 1, trustWeight: 3, personalNotes: "epic", completedAt: null, reviewDone: false,
    });
    expect(dune.id).toMatch(/^itm_[0-9a-f]{8}$/);
    const sev = rows.find((r) => r.title === "Severance")!;
    expect(sev).toMatchObject({
      status: "Completed", completedAt: FIXED_NOW.toISOString(), myRating: 5, consumedYear: 2025, reviewDone: true,
      alternativeMatchesNote: "also 2006 show", recommenderName: "Self", trustWeight: 3, mediaType: "TV",
    });
    const log = await db.select().from(activityLog);
    expect(log).toHaveLength(3);
    expect(log.every((l) => l.eventType === "CREATED" && l.dayOfWeekPt === 3 && l.hourOfDayPt === 12)).toBe(true);
    expect(log.map((l) => l.itemTitleSnapshot).sort()).toEqual(["Dune", "Hyperion", "Severance"]);
    const il = await db.select().from(intakeLog);
    expect(il).toHaveLength(3);
    expect(il.every((l) => l.source === "webhook")).toBe(true);
    expect(il.find((l) => l.rawLine === "buy milk")).toBeTruthy();
  });

  it("uses trust 5 from Gemini for Justin and passes it through", async () => {
    const { db } = setup();
    const f = geminiFetch(() => geminiBody([item({ recommenderName: "Justin", trustWeight: 5 })]));
    await ingestRawLines(deps(db, f.fetchImpl), ["dune from Justin"], "gdoc");
    expect((await db.select().from(mediaItems))[0]!.trustWeight).toBe(5);
  });

  it("skips already-logged lines with zero Gemini calls", async () => {
    const { db } = setup();
    const f = geminiFetch(echoGemini);
    await ingestRawLines(deps(db, f.fetchImpl), ["Dune"], "gdoc");
    expect(f.calls).toHaveLength(1);
    const res = await ingestRawLines(deps(db, f.fetchImpl), ["  DUNE "], "webhook");
    expect(f.calls).toHaveLength(1);
    expect(res).toMatchObject({ accepted: 0, skippedDuplicates: 1, created: 0 });
    expect(await db.select().from(mediaItems)).toHaveLength(1);
  });

  it("drops duplicates inside one batch", async () => {
    const { db } = setup();
    const f = geminiFetch(echoGemini);
    const res = await ingestRawLines(deps(db, f.fetchImpl), ["Dune", "dune ", "Alien"], "gdoc");
    expect(res).toMatchObject({ accepted: 2, skippedDuplicates: 1, created: 2 });
    expect(await db.select().from(intakeLog)).toHaveLength(2);
  });

  it("caps at 25 lines and reports remaining", async () => {
    const { db } = setup();
    const f = geminiFetch(echoGemini);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const res = await ingestRawLines(deps(db, f.fetchImpl), lines, "gdoc");
    expect(res).toMatchObject({ accepted: 25, created: 25, remaining: 5 });
  });

  describe("Stage 1 merge", () => {
    it("merges same title, type and year; different year does not", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_aaaaaaaa", title: "Dune", yearHint: 2021, recommenderName: "Alex", trustWeight: 3 });
      const f = geminiFetch(() => geminiBody([item({ title: "dune", yearHint: 2021, recommenderName: "Justin", trustWeight: 5, personalNotes: "great" }), item({ title: "Dune", yearHint: 1984 })]));
      const res = await ingestRawLines(deps(db, f.fetchImpl), ["dune 2021 justin says great"], "gdoc");
      expect(res).toMatchObject({ merged: 1, created: 1 });
      const old = (await db.select().from(mediaItems).where(eq(mediaItems.id, "itm_aaaaaaaa")))[0]!;
      expect(old).toMatchObject({ recommenderName: "Alex, Justin", recommenderCount: 2, trustWeight: 5, personalNotes: "great", updatedAt: FIXED_NOW.toISOString(), priorityScore: 51 });
      expect(await db.select().from(mediaItems)).toHaveLength(2);
      const merged = (await db.select().from(activityLog)).find((l) => l.eventType === "MERGED_RECOMMENDATION")!;
      expect(merged).toMatchObject({ itemId: "itm_aaaaaaaa", oldValue: "Alex", newValue: "Alex, Justin", dayOfWeekPt: 3, hourOfDayPt: 12 });
      expect((await db.select().from(activityLog)).filter((l) => l.eventType === "CREATED")).toHaveLength(1);
    });

    it("merges a no-hint item into a row with no year on either side", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_bbbbbbbb", title: "Alien" });
      const f = geminiFetch(() => geminiBody([item({ title: "ALIEN" })]));
      const res = await ingestRawLines(deps(db, f.fetchImpl), ["alien"], "gdoc");
      expect(res).toMatchObject({ merged: 1, created: 0 });
      expect(res.items[0]).toMatchObject({ id: "itm_bbbbbbbb", merged: true });
    });

    it("matches a hinted item against year_hint when release_year is null", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_cccccccc", title: "Heat", yearHint: 1995 });
      const f = geminiFetch(() => geminiBody([item({ title: "Heat", yearHint: 1995 })]));
      expect((await ingestRawLines(deps(db, f.fetchImpl), ["heat 1995"], "gdoc")).merged).toBe(1);
    });

    it("does NOT merge a no-hint item into an enriched row with release_year", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_dddddddd", title: "Dune", releaseYear: 2021, enrichmentStatus: "ENRICHED" });
      const f = geminiFetch(() => geminiBody([item({ title: "Dune" })]));
      const res = await ingestRawLines(deps(db, f.fetchImpl), ["dune"], "gdoc");
      expect(res).toMatchObject({ merged: 0, created: 1 });
      expect(await db.select().from(mediaItems)).toHaveLength(2);
    });

    it("does not merge across media types or into Archived rows", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_eeeeeeee", title: "Dune", status: "Archived" });
      await seed(db, { id: "itm_ffffffff", title: "Dune", mediaType: "Book" });
      const f = geminiFetch(() => geminiBody([item({ title: "Dune" })]));
      const res = await ingestRawLines(deps(db, f.fetchImpl), ["dune"], "gdoc");
      expect(res).toMatchObject({ merged: 0, created: 1 });
      expect((await db.select().from(mediaItems).where(eq(mediaItems.id, "itm_eeeeeeee")))[0]!.recommenderCount).toBe(1);
    });

    it("keeps Alex+Alex as one recommender", async () => {
      const { db } = setup();
      await seed(db, { id: "itm_11111111", title: "Alien", recommenderName: "Alex", personalNotes: "scary" });
      const f = geminiFetch(() => geminiBody([item({ title: "Alien", recommenderName: "alex", trustWeight: 2, personalNotes: "scary" })]));
      await ingestRawLines(deps(db, f.fetchImpl), ["alien from alex"], "gdoc");
      const row = (await db.select().from(mediaItems))[0]!;
      expect(row).toMatchObject({ recommenderName: "Alex", recommenderCount: 1, trustWeight: 3, personalNotes: "scary" });
    });

    it("merges same-key items within one batch before touching the database", async () => {
      const { db } = setup();
      const f = geminiFetch(() =>
        geminiBody([
          item({ lineIndex: 0, title: "Dune", recommenderName: "Alex", personalNotes: "a" }),
          item({ lineIndex: 1, title: "dune", recommenderName: "Justin", trustWeight: 5, personalNotes: "b" }),
        ]),
      );
      const res = await ingestRawLines(deps(db, f.fetchImpl), ["dune from alex, a", "dune from justin, b"], "gdoc");
      expect(res).toMatchObject({ created: 1, merged: 0 });
      expect((await db.select().from(mediaItems))[0]).toMatchObject({ recommenderName: "Alex, Justin", recommenderCount: 2, trustWeight: 5, personalNotes: "a | b" });
    });
  });

  it("writes nothing and throws when Gemini fails, without leaking secrets", async () => {
    const { db } = setup();
    const f = geminiFetch(jsonResponse({ error: "boom" }, 500));
    const err = await ingestRawLines(deps(db, f.fetchImpl), ["Dune"], "gdoc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBe(500);
    expect((err as Error).message).not.toContain(GEMINI_KEY);
    expect((err as Error).message).not.toContain("Dune");
    expect(await db.select().from(intakeLog)).toHaveLength(0);
    expect(await db.select().from(mediaItems)).toHaveLength(0);
  });

  it("throws GeminiError on unparseable JSON and missing key", async () => {
    const { db } = setup();
    const bad = geminiFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }));
    await expect(ingestRawLines(deps(db, bad.fetchImpl), ["x"], "gdoc")).rejects.toBeInstanceOf(GeminiError);
    await expect(ingestRawLines({ db, env: {}, fetchImpl: bad.fetchImpl }, ["y"], "gdoc")).rejects.toBeInstanceOf(GeminiError);
    expect(await db.select().from(intakeLog)).toHaveLength(0);
  });

  it("logs and reports lines that yield no items", async () => {
    const { db } = setup();
    const f = geminiFetch(() => geminiBody([]));
    const res = await ingestRawLines(deps(db, f.fetchImpl), ["remember to call mom"], "gdoc");
    expect(res).toMatchObject({ accepted: 1, created: 0, unparsedLines: ["remember to call mom"] });
    expect((await db.select().from(intakeLog))[0]!.rawLine).toBe("remember to call mom");
    await ingestRawLines(deps(db, f.fetchImpl), ["remember to call mom"], "gdoc");
    expect(f.calls).toHaveLength(1);
  });

  it("counts rejected items", async () => {
    const { db } = setup();
    const f = geminiFetch(() => geminiBody([item(), item({ title: "" })]));
    expect((await ingestRawLines(deps(db, f.fetchImpl), ["dune"], "gdoc")).rejected).toBe(1);
  });

  it("survives a concurrent run on the same lines: one row, no error", async () => {
    const { db } = setup();
    const f = geminiFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return geminiBody([item({ title: "Dune" })]);
    });
    const [a, b] = await Promise.all([
      ingestRawLines(deps(db, f.fetchImpl), ["Dune"], "gdoc"),
      ingestRawLines(deps(db, f.fetchImpl), ["Dune"], "webhook"),
    ]);
    expect(f.calls).toHaveLength(2);
    expect(await db.select().from(mediaItems)).toHaveLength(1);
    expect(await db.select().from(intakeLog)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
    expect([a.created, b.created].sort()).toEqual([0, 1]);
  });
});

describe("Gemini retries", () => {
  function sequence(statuses: number[]) {
    let i = 0;
    const calls: number[] = [];
    const fetchImpl = (async () => {
      const status = statuses[Math.min(i++, statuses.length - 1)]!;
      calls.push(status);
      return status === 200 ? geminiBody([item()]) : jsonResponse({ error: "busy" }, status);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("retries a 503 and succeeds, pausing between attempts", async () => {
    const { fetchImpl, calls } = sequence([503, 503, 200]);
    const pauses: number[] = [];
    const out = await parseLinesWithGemini({
      lines: ["Dune"],
      env,
      fetchImpl,
      sleep: async (ms) => void pauses.push(ms),
    });
    expect(out.items).toHaveLength(1);
    expect(calls).toEqual([503, 503, 200]);
    expect(pauses).toEqual(GEMINI_RETRY_DELAYS_MS);
  });

  it("gives up after two retries with the last status and no secrets", async () => {
    const { fetchImpl, calls } = sequence([503]);
    const err = await parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain(GEMINI_KEY);
    expect(calls).toHaveLength(3);
  });

  it("reports Gemini's own reason in the error, trimmed", async () => {
    const f = (async () =>
      jsonResponse({ error: { message: "Quota exceeded for this model" } }, 429)) as typeof fetch;
    const err = await parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl: f, sleep: async () => {} }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Gemini request failed: HTTP 429 (Quota exceeded for this model)");
    expect(err.message).not.toContain(GEMINI_KEY);
  });

  it("does not retry a 400", async () => {
    const { fetchImpl, calls } = sequence([400]);
    await expect(parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("counts every attempt against the subrequest budget", async () => {
    const { fetchImpl } = sequence([503]);
    const budget = createSubrequestBudget(2);
    await expect(
      parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl, budget, sleep: async () => {} }),
    ).rejects.toMatchObject({ name: "SubrequestBudgetError" });
  });

  it("treats a hung connection as busy: retries after a timeout, then reports 504", async () => {
    let n = 0;
    const hang = (async () => {
      n++;
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch;
    const err = await parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl: hang, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(504);
    expect(n).toBe(3);

    let m = 0;
    const flaky = (async () => {
      if (m++ === 0) throw new DOMException("The operation timed out", "TimeoutError");
      return geminiBody([item()]);
    }) as typeof fetch;
    const out = await parseLinesWithGemini({ lines: ["Dune"], env, fetchImpl: flaky, sleep: async () => {} });
    expect(out.items).toHaveLength(1);
  });
});
