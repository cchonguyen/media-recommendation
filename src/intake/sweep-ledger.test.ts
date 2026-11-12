import { describe, expect, it, vi } from "vitest";
import { sweepRuns } from "../db/schema";
import type { NewSweepRun } from "../db/schema";
import { setCachedValue, GOOGLE_TOKEN_CACHE_KEY } from "../google/token";
import { createFakeFetch, jsonResponse } from "../google/test-helpers";
import { sweepInboxDoc } from "./doc-sweep";
import { lastSweepRuns, recordSweepRun, runLoggedSweep } from "./sweep-ledger";
import type { SweepTrigger } from "./sweep-ledger";
import { FIXED_NOW, GEMINI_KEY, GEMINI_URL, echoGemini, geminiBody, item, setup } from "./test-fixtures";

const DOC_ID = "doc123";
const DOC_URL = `https://docs.googleapis.com/v1/documents/${DOC_ID}`;
const BATCH_URL = `${DOC_URL}:batchUpdate`;
const HEADER = "# Inbox — paste or dictate below";

type Handler = Parameters<typeof createFakeFetch>[0][string];

function makeDoc(texts: string[], revisionId = "rev-1") {
  let idx = 1;
  const content = texts.map((t) => {
    const startIndex = idx;
    idx += t.length + 1;
    return { startIndex, endIndex: idx, paragraph: { elements: [{ textRun: { content: `${t}\n` } }] } };
  });
  return { revisionId, body: { content } };
}

async function ledgerSetup(texts: string[], opts: { doc?: Handler; gemini?: Handler } = {}) {
  const { db, d1 } = setup();
  await setCachedValue(db, GOOGLE_TOKEN_CACHE_KEY, "tok", Math.floor(Date.now() / 1000) + 3000);
  const f = createFakeFetch({
    [DOC_URL]: opts.doc ?? jsonResponse(makeDoc(texts)),
    [BATCH_URL]: jsonResponse({}),
    [GEMINI_URL]: opts.gemini ?? echoGemini,
  });
  const env = { INBOX_DOC_ID: DOC_ID, GEMINI_API_KEY: GEMINI_KEY };
  const deps = { db, env, fetchImpl: f.fetchImpl, now: () => FIXED_NOW };
  const run = (trigger: SweepTrigger = "cron") => runLoggedSweep(deps, trigger, sweepInboxDoc);
  return { db, d1, deps, run };
}

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

const rowFor = (i: number): NewSweepRun => ({
  startedAt: "2026-11-12T00:00:00.000Z",
  durationMs: i,
  trigger: "cron",
  outcome: "ok",
});

describe("runLoggedSweep", () => {
  it("records one ok row for a clean sweep", async () => {
    quiet();
    const s = await ledgerSetup([HEADER, "Dune", "Alien"]);
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, ingest: { created: 2 } });
    const rows = await lastSweepRuns(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ok", stage: null, linesSeen: 2, created: 2, merged: 0, duplicates: 0,
      keptInDoc: 0, rejected: 0, cleared: true, error: null, trigger: "cron",
    });
    vi.restoreAllMocks();
  });

  it("records a partial row when a line stays unparsed", async () => {
    quiet();
    const gemini: Handler = (call) => {
      const prompt = JSON.parse(call.body ?? "{}").contents[0].parts[0].text as string;
      const lines = prompt.split("Lines:\n")[1]!.split("\n").map((l) => l.replace(/^\d+: /, ""));
      return geminiBody(lines.flatMap((l, i) => (l.startsWith("junk") ? [] : [item({ lineIndex: i, title: `T:${l}` })])));
    };
    const s = await ledgerSetup([HEADER, "Dune", "junk one"], { gemini });
    await s.run();
    const rows = await lastSweepRuns(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("partial");
    expect(rows[0]!.keptInDoc).toBeGreaterThan(0);
    expect(rows[0]!.created).toBe(1);
    vi.restoreAllMocks();
  });

  it("rethrows a Gemini failure and records a failed parse row", async () => {
    quiet();
    const s = await ledgerSetup([HEADER, "Dune"], { gemini: jsonResponse({}, 429) });
    await expect(s.run()).rejects.toMatchObject({ name: "GeminiError", status: 429 });
    const rows = await lastSweepRuns(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", stage: "parse" });
    expect(rows[0]!.error).toContain("HTTP 429");
    vi.restoreAllMocks();
  });

  it("records stage google-docs for a Docs failure", async () => {
    quiet();
    const s = await ledgerSetup([], { doc: jsonResponse({ error: { status: "INTERNAL", message: "boom" } }, 500) });
    await expect(s.run()).rejects.toBeDefined();
    const rows = await lastSweepRuns(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", stage: "google-docs" });
    vi.restoreAllMocks();
  });

  it("writes no row for a nothing-to-do sweep", async () => {
    quiet();
    const s = await ledgerSetup([HEADER]);
    expect(await s.run()).toMatchObject({ skipped: "nothing-to-do" });
    expect(await lastSweepRuns(s.db)).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("stores the trigger value", async () => {
    quiet();
    const s = await ledgerSetup([HEADER, "Dune"]);
    await s.run("button");
    expect((await lastSweepRuns(s.db))[0]!.trigger).toBe("button");
    vi.restoreAllMocks();
  });

  it("does not throw or change the result when the ledger write breaks", async () => {
    quiet();
    const s = await ledgerSetup([HEADER, "Dune"]);
    await s.d1.prepare("DROP TABLE sweep_runs").run();
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, ingest: { created: 1 } });
    vi.restoreAllMocks();
  });
});

describe("recordSweepRun", () => {
  it("keeps only the newest 200 rows", async () => {
    quiet();
    const { db } = setup();
    for (let i = 1; i <= 205; i++) await recordSweepRun(db, rowFor(i));
    const rows = await db.select().from(sweepRuns);
    expect(rows).toHaveLength(200);
    const ids = rows.map((r) => r.id);
    expect(Math.min(...ids)).toBe(6);
    expect(Math.max(...ids)).toBe(205);
    vi.restoreAllMocks();
  });
});
