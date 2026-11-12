import { describe, expect, it } from "vitest";
import { activityLog, intakeLog, mediaItems, sweepRuns, systemKv } from "../db/schema";
import { setCachedValue, GOOGLE_TOKEN_CACHE_KEY } from "../google/token";
import { createFakeFetch, jsonResponse } from "../google/test-helpers";
import { testParseInbox } from "./test-parse";
import { FIXED_NOW, GEMINI_KEY, GEMINI_URL, echoGemini, setup } from "./test-fixtures";

const DOC_ID = "doc123";
const DOC_URL = `https://docs.googleapis.com/v1/documents/${DOC_ID}`;
const BATCH_URL = `${DOC_URL}:batchUpdate`;
const HEADER = "# Inbox — paste or dictate below";

function makeDoc(texts: string[]) {
  let idx = 1;
  const content = texts.map((t) => {
    const startIndex = idx;
    idx += t.length + 1;
    return { startIndex, endIndex: idx, paragraph: { elements: [{ textRun: { content: `${t}\n` } }] } };
  });
  return { revisionId: "rev-1", body: { content } };
}

async function setupDoc(texts: string[], gemini: Parameters<typeof createFakeFetch>[0][string] = echoGemini) {
  const { db } = setup();
  await setCachedValue(db, GOOGLE_TOKEN_CACHE_KEY, "tok", Math.floor(Date.now() / 1000) + 3000);
  const f = createFakeFetch({ [DOC_URL]: jsonResponse(makeDoc(texts)), [BATCH_URL]: jsonResponse({}), [GEMINI_URL]: gemini });
  const env = { INBOX_DOC_ID: DOC_ID, GEMINI_API_KEY: GEMINI_KEY };
  return { db, f, run: () => testParseInbox({ db, env, fetchImpl: f.fetchImpl, now: () => FIXED_NOW }) };
}

const count = async (db: ReturnType<typeof setup>["db"]) =>
  (await Promise.all([mediaItems, intakeLog, activityLog, sweepRuns].map((t) => db.select().from(t)))).map((r) => r.length);

describe("testParseInbox", () => {
  it("skips without an inbox doc id", async () => {
    const { db } = setup();
    const f = createFakeFetch({});
    expect(await testParseInbox({ db, env: {}, fetchImpl: f.fetchImpl })).toEqual({ skipped: "no-inbox-doc" });
    expect(f.calls).toHaveLength(0);
  });

  it("skips a header-only doc", async () => {
    const s = await setupDoc([HEADER, "", "# note"]);
    expect(await s.run()).toEqual({ skipped: "nothing-to-do" });
  });

  it("parses template lines with no model call and writes nothing", async () => {
    const s = await setupDoc([HEADER, "Severance (TV) | Recommender: Self | Notes: ", "Hacks (TV) | Status: Completed | Consumed: 2026 | Recommender: Self"]);
    const before = await count(s.db);
    const r = await s.run();
    expect(r).toMatchObject({ lines: [{ ok: true, title: "Severance", mediaType: "TV", status: "Backlog" }, { ok: true, title: "Hacks", status: "Completed" }] });
    expect(s.f.calls.filter((c) => c.url === GEMINI_URL)).toHaveLength(0);
    expect(s.f.calls.filter((c) => c.url === BATCH_URL)).toHaveLength(0);
    expect(await count(s.db)).toEqual(before);
    expect(await s.db.select().from(systemKv)).toHaveLength(1); // only the pre-seeded token
  });

  it("reports a reason for an unreadable free-form line when Gemini returns 429", async () => {
    const s = await setupDoc(
      [HEADER, "Severance (TV) | Recommender: Self", "that show about the thing"],
      () => jsonResponse({ error: { message: "Quota exceeded" } }, 429),
    );
    const r = (await s.run()) as { lines: { ok: boolean; reason?: string }[]; degraded?: boolean };
    expect(r.lines[0]!.ok).toBe(true);
    expect(r.lines[1]!.ok).toBe(false);
    expect(r.lines[1]!.reason).toBeTruthy();
    expect(r.degraded).toBe(true);
    expect(s.f.calls.filter((c) => c.url === BATCH_URL)).toHaveLength(0);
  });

  it("returns every line as not ok with the error when only free-form lines fail", async () => {
    const s = await setupDoc([HEADER, "some vague line"], () => jsonResponse({ error: { message: "Quota exceeded" } }, 429));
    const r = (await s.run()) as { lines: { ok: boolean; reason?: string }[] };
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ ok: false });
    expect(r.lines[0]!.reason).toContain("429");
  });
});
