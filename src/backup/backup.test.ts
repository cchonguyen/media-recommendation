import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { curatedListItems, curatedLists, mediaItems, systemKv } from "../db/schema";
import { seed, setup } from "../intake/test-fixtures";
import { createFakeFetch, jsonResponse } from "../google/test-helpers";
import type { FakeHandler } from "../google/test-helpers";
import { setCachedValue } from "../google/token";
import { createBackupRoutes } from "./routes";
import { ITEM_HEADER, LAST_BACKUP_KEY, LISTS_HEADER, exportToSheets, sanitizeCell } from "./export";

const NOW = new Date("2026-07-10T12:00:00Z");
const SHEET = "sheet123";
const CLEAR = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchClear`;
const UPDATE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchUpdate`;
const ENV = {
  BACKUP_SHEET_ID: SHEET,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@test.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: "PRIVATE-KEY-MATERIAL-SECRET",
};

async function harness(handlers?: Record<string, FakeHandler | Response>) {
  const { d1, db } = setup();
  await setCachedValue(db, "google_access_token", "cached-token-SECRET", 4102444800);
  const fake = createFakeFetch(handlers ?? { [CLEAR]: jsonResponse({}), [UPDATE]: jsonResponse({}) });
  return { d1, db, ...fake };
}

interface Body {
  data: { range: string; values: unknown[][] }[];
}
const updateBody = (calls: { url: string; body: string | null }[]): Body => JSON.parse(calls.find((c) => c.url === UPDATE)!.body!);

describe("exportToSheets", () => {
  it("clears then updates once, in order, with headers on every tab", async () => {
    const h = await harness();
    const r = await exportToSheets({ db: h.db, env: ENV, fetchImpl: h.fetchImpl, now: () => NOW });
    expect(h.calls.map((c) => c.url)).toEqual([CLEAR, UPDATE]);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({
      ranges: ["Library_Archive!A2:Z", "Active_Queue!A2:Z", "Curated_Lists!A2:Z"],
    });
    const b = updateBody(h.calls);
    expect(b.data.map((d) => d.range)).toEqual(["Library_Archive!A1", "Active_Queue!A1", "Curated_Lists!A1"]);
    expect(b.data[0]!.values[0]).toEqual(ITEM_HEADER);
    expect(b.data[1]!.values[0]).toEqual(ITEM_HEADER);
    expect(b.data[2]!.values[0]).toEqual(LISTS_HEADER);
    expect(ITEM_HEADER.length).toBeLessThanOrEqual(26);
    expect(r).toMatchObject({ rows: { library: 0, active: 0, lists: 0 }, truncated: { library: false, active: false, lists: false } });
  });

  it("routes rows by status and includes lists", async () => {
    const h = await harness();
    await seed(h.db, { id: "b", title: "Back", status: "Backlog", priorityScore: 10 });
    await seed(h.db, { id: "n", title: "Next", status: "Up Next", priorityScore: 90 });
    await seed(h.db, { id: "a", title: "Act", status: "Active" });
    await seed(h.db, { id: "p", title: "Pau", status: "Paused" });
    await seed(h.db, { id: "c", title: "Comp", status: "Completed", personalNotes: "my note", reviewText: "great" });
    await seed(h.db, { id: "x", title: "Aban", status: "Abandoned" });
    await seed(h.db, { id: "z", title: "Arch", status: "Archived" });
    await h.db.insert(curatedLists).values({ id: "l1", slug: "faves", title: "Faves", isPublic: true, createdAt: "t", updatedAt: "t" });
    await h.db.insert(curatedListItems).values([
      { id: "i2", listId: "l1", mediaItemId: "n", rank: 2, blurb: "two", createdAt: "t" },
      { id: "i1", listId: "l1", mediaItemId: "c", rank: 1, blurb: "one", createdAt: "t" },
    ]);
    const r = await exportToSheets({ db: h.db, env: ENV, fetchImpl: h.fetchImpl, now: () => NOW });
    expect(r).toMatchObject({ rows: { library: 3, active: 4, lists: 2 } });
    const b = updateBody(h.calls);
    const titleCol = ITEM_HEADER.indexOf("title");
    const lib = b.data[0]!.values.slice(1).map((v) => v[titleCol]);
    expect(lib.sort()).toEqual(["Aban", "Arch", "Comp"]);
    const act = b.data[1]!.values.slice(1).map((v) => v[titleCol]);
    expect(act[0]).toBe("Next");
    expect(act.sort()).toEqual(["Act", "Back", "Next", "Pau"]);
    const comp = b.data[0]!.values.slice(1).find((v) => v[titleCol] === "Comp")!;
    expect(comp[ITEM_HEADER.indexOf("notes")]).toBe("my note");
    expect(comp[ITEM_HEADER.indexOf("review_text")]).toBe("great");
    expect(b.data[2]!.values.slice(1)).toEqual([
      ["Faves", "faves", true, 1, "Comp", "one"],
      ["Faves", "faves", true, 2, "Next", "two"],
    ]);
  });

  it("caps each tab at 500 rows and flags truncation", async () => {
    const h = await harness();
    const iso = "2026-01-01T00:00:00.000Z";
    const vals = Array.from({ length: 502 }, (_, i) => ({
      id: `q${i}`,
      title: `T${i}`,
      rawInput: `T${i}`,
      mediaType: "Movie" as const,
      status: "Backlog" as const,
      lastStatusChangeAt: iso,
      createdAt: iso,
      updatedAt: iso,
    }));
    for (let i = 0; i < vals.length; i += 50) await h.db.insert(mediaItems).values(vals.slice(i, i + 50));
    await seed(h.db, { id: "one", title: "Done", status: "Completed" });
    const r = await exportToSheets({ db: h.db, env: ENV, fetchImpl: h.fetchImpl, now: () => NOW });
    expect(r).toMatchObject({ rows: { library: 1, active: 500, lists: 0 }, truncated: { library: false, active: true, lists: false } });
    expect(updateBody(h.calls).data[1]!.values).toHaveLength(501);
  });

  it("neutralises formula injection and truncates long strings", async () => {
    expect(sanitizeCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(sanitizeCell("+1")).toBe("'+1");
    expect(sanitizeCell("-x")).toBe("'-x");
    expect(sanitizeCell("@cmd")).toBe("'@cmd");
    expect(sanitizeCell("plain")).toBe("plain");
    expect(sanitizeCell(-4)).toBe(-4);
    expect(sanitizeCell(null)).toBeNull();
    expect(sanitizeCell(true)).toBe(true);
    expect((sanitizeCell("x".repeat(5000)) as string).length).toBe(2000);

    const h = await harness();
    await seed(h.db, { id: "f", title: "=HYPERLINK(\"evil\")", status: "Backlog", personalNotes: "y".repeat(3000), myRating: -1 });
    await exportToSheets({ db: h.db, env: ENV, fetchImpl: h.fetchImpl, now: () => NOW });
    const row = updateBody(h.calls).data[1]!.values[1]!;
    expect(row[ITEM_HEADER.indexOf("title")]).toBe("'=HYPERLINK(\"evil\")");
    expect((row[ITEM_HEADER.indexOf("notes")] as string).length).toBe(2000);
    expect(row[ITEM_HEADER.indexOf("my_rating")]).toBe(-1);
  });

  it("skips with zero fetches when not configured", async () => {
    const h = await harness();
    for (const env of [{}, { ...ENV, BACKUP_SHEET_ID: undefined }, { ...ENV, GOOGLE_PRIVATE_KEY: undefined }]) {
      expect(await exportToSheets({ db: h.db, env, fetchImpl: h.fetchImpl })).toEqual({ skipped: "not-configured" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("uses at most 3 Google calls per run", async () => {
    const h = await harness();
    await exportToSheets({ db: h.db, env: ENV, fetchImpl: h.fetchImpl, now: () => NOW });
    expect(h.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("POST /api/backup", () => {
  function app(h: Awaited<ReturnType<typeof harness>>) {
    const a = new Hono();
    a.route(
      "/api",
      createBackupRoutes({ now: () => NOW, exporter: (d) => exportToSheets({ ...d, fetchImpl: h.fetchImpl }) }),
    );
    return (env: object) => a.request("/api/backup", { method: "POST" }, { DB: h.d1, ...env });
  }
  const kv = (h: Awaited<ReturnType<typeof harness>>) => h.db.select().from(systemKv).where(eq(systemKv.key, LAST_BACKUP_KEY));

  it("returns the summary and records last_backup_at on success", async () => {
    const h = await harness();
    const res = await app(h)(ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: { library: 0, active: 0, lists: 0 }, lastBackupAt: NOW.toISOString() });
    const rows = await kv(h);
    expect(rows[0]!.value).toBe(NOW.toISOString());
  });

  it("503 not_configured without a network call or stamp", async () => {
    const h = await harness();
    const res = await app(h)({});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("not_configured");
    expect(h.calls).toHaveLength(0);
    expect(await kv(h)).toHaveLength(0);
  });

  it("502 backup_failed with a safe body on a Google 500, and no stamp", async () => {
    const h = await harness({
      [CLEAR]: jsonResponse({ error: { status: "INTERNAL", message: "boom cached-token-SECRET PRIVATE-KEY-MATERIAL-SECRET" } }, 500),
    });
    const res = await app(h)(ENV);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("backup_failed");
    for (const s of ["SECRET", "PRIVATE-KEY", "boom", "Bearer"]) expect(text).not.toContain(s);
    expect(h.calls.map((c) => c.url)).toEqual([CLEAR]);
    expect(await kv(h)).toHaveLength(0);
  });
});
