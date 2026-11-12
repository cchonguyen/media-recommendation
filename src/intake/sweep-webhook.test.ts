import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { activityLog, intakeLog, mediaItems } from "../db/schema";
import { setCachedValue, GOOGLE_TOKEN_CACHE_KEY } from "../google/token";
import { createFakeFetch, jsonResponse } from "../google/test-helpers";
import { sweepInboxDoc } from "./doc-sweep";
import { createIntakeRoutes } from "./webhook";
import { FIXED_NOW, GEMINI_KEY, GEMINI_URL, WEBHOOK_SECRET, echoGemini, geminiBody, item, setup } from "./test-fixtures";

const DOC_ID = "doc123";
const DOC_URL = `https://docs.googleapis.com/v1/documents/${DOC_ID}`;
const BATCH_URL = `${DOC_URL}:batchUpdate`;
const HEADER = "# Inbox — paste or dictate below";

/** Builds a Docs API payload. Each paragraph is its text plus a newline; indexes start at 1. */
function makeDoc(texts: string[], revisionId = "rev-1") {
  let idx = 1;
  const content = texts.map((t) => {
    const startIndex = idx;
    idx += t.length + 1;
    return { startIndex, endIndex: idx, paragraph: { elements: [{ textRun: { content: `${t}\n` } }] } };
  });
  return { revisionId, body: { content }, _content: content };
}

async function sweepSetup(texts: string[], opts: { batch?: Response; gemini?: Parameters<typeof createFakeFetch>[0][string] } = {}) {
  const { db } = setup();
  await setCachedValue(db, GOOGLE_TOKEN_CACHE_KEY, "tok", Math.floor(Date.now() / 1000) + 3000);
  const doc = makeDoc(texts);
  const f = createFakeFetch({
    [DOC_URL]: jsonResponse(doc),
    [BATCH_URL]: opts.batch ?? jsonResponse({}),
    [GEMINI_URL]: opts.gemini ?? echoGemini,
  });
  const env = { INBOX_DOC_ID: DOC_ID, GEMINI_API_KEY: GEMINI_KEY };
  return { db, doc, f, env, run: () => sweepInboxDoc({ db, env, fetchImpl: f.fetchImpl, now: () => FIXED_NOW }) };
}

const batchCalls = (f: { calls: { url: string; body: string | null }[] }) => f.calls.filter((c) => c.url === BATCH_URL);
const geminiCalls = (f: { calls: { url: string; body: string | null }[] }) => f.calls.filter((c) => c.url === GEMINI_URL);

describe("sweepInboxDoc", () => {
  it("skips when INBOX_DOC_ID is missing", async () => {
    const { db } = setup();
    const f = createFakeFetch({});
    expect(await sweepInboxDoc({ db, env: {}, fetchImpl: f.fetchImpl })).toEqual({ skipped: "no-inbox-doc" });
    expect(f.calls).toHaveLength(0);
  });

  it("ingests all lines, keeps the header, and deletes up to the final newline", async () => {
    const s = await sweepSetup([HEADER, "Dune", "Alien"]);
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, remainingInDoc: 0, ingest: { created: 2 } });
    const rows = await s.db.select().from(mediaItems);
    expect(rows.map((x) => x.title).sort()).toEqual(["T:Alien", "T:Dune"]);
    expect(rows.some((x) => x.title.includes("Inbox"))).toBe(false);
    const calls = batchCalls(s.f);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!);
    const header = s.doc._content[0]!;
    expect(body.requests[0].deleteContentRange.range).toEqual({ startIndex: header.endIndex, endIndex: s.doc._content[2]!.endIndex - 1 });
    expect(body.writeControl.targetRevisionId).toBe("rev-1");
  });

  it("ignores blank and # lines but still clears them with the range", async () => {
    const s = await sweepSetup([HEADER, "", "# note", "Dune"]);
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, ingest: { created: 1 } });
  });

  it("caps at 25 and deletes only through the 25th paragraph", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
    const s = await sweepSetup([HEADER, ...lines]);
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, remainingInDoc: 5, ingest: { accepted: 25 } });
    const body = JSON.parse(batchCalls(s.f)[0]!.body!);
    expect(body.requests[0].deleteContentRange.range).toEqual({
      startIndex: s.doc._content[1]!.startIndex,
      endIndex: s.doc._content[25]!.endIndex,
    });
  });

  it("makes no Gemini or delete call for a header-only or empty doc", async () => {
    for (const texts of [[HEADER], [HEADER, "", "# only a comment"]]) {
      const s = await sweepSetup(texts);
      const r = await s.run();
      expect(r).toMatchObject({ skipped: "nothing-to-do" });
      expect(geminiCalls(s.f)).toHaveLength(0);
      expect(batchCalls(s.f)).toHaveLength(0);
    }
  });

  it("returns cleared false on a 400 delete and keeps the ingested rows", async () => {
    const s = await sweepSetup([HEADER, "Dune"], { batch: jsonResponse({ error: { status: "FAILED_PRECONDITION", message: "stale" } }, 400) });
    const r = await s.run();
    expect(r).toMatchObject({ cleared: false, ingest: { created: 1 } });
    expect(await s.db.select().from(mediaItems)).toHaveLength(1);
    expect(await s.db.select().from(intakeLog)).toHaveLength(1);
    // Next tick: the doc still has the line, but intake_log skips it and no Gemini call is made.
    const r2 = await s.run();
    expect(r2).toMatchObject({ cleared: false, ingest: { accepted: 0, skippedDuplicates: 1 } });
    expect(geminiCalls(s.f)).toHaveLength(1);
  });

  it("leaves unreadable lines in the Doc and deletes only the saved ones", async () => {
    const gemini: Parameters<typeof createFakeFetch>[0][string] = (call) => {
      const prompt = JSON.parse(call.body ?? "{}").contents[0].parts[0].text as string;
      const lines = prompt.split("Lines:\n")[1]!.split("\n").map((l) => l.replace(/^\d+: /, ""));
      return geminiBody(lines.flatMap((l, i) => (l.startsWith("junk") ? [] : [item({ lineIndex: i, title: `T:${l}` })])));
    };
    const s = await sweepSetup([HEADER, "Dune", "junk one", "Alien", "junk two"], { gemini });
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, keptInDoc: 2, ingest: { created: 2, unparsedLines: ["junk one", "junk two"] } });
    expect((await s.db.select().from(mediaItems)).map((x) => x.title).sort()).toEqual(["T:Alien", "T:Dune"]);
    expect(await s.db.select().from(intakeLog)).toHaveLength(2);
    const body = JSON.parse(batchCalls(s.f)[0]!.body!);
    const c = s.doc._content;
    // Highest range first: Alien, then Dune. Junk paragraphs are untouched.
    expect(body.requests.map((q: { deleteContentRange: { range: unknown } }) => q.deleteContentRange.range)).toEqual([
      { startIndex: c[3]!.startIndex, endIndex: c[3]!.endIndex },
      { startIndex: c[1]!.startIndex, endIndex: c[1]!.endIndex },
    ]);
  });

  it("sends no delete and keeps every line when nothing could be read", async () => {
    const s = await sweepSetup([HEADER, "junk one", "junk two"], { gemini: () => geminiBody([]) });
    const r = await s.run();
    expect(r).toMatchObject({ cleared: false, keptInDoc: 2, ingest: { created: 0, accepted: 0 } });
    expect(batchCalls(s.f)).toHaveLength(0);
    expect(await s.db.select().from(mediaItems)).toHaveLength(0);
    expect(await s.db.select().from(intakeLog)).toHaveLength(0);
    // Next tick retries the same lines instead of skipping them as already seen.
    await s.run();
    expect(geminiCalls(s.f)).toHaveLength(2);
  });

  it("reprocesses lines a buggy earlier run logged as seen without saving them", async () => {
    const s = await sweepSetup([HEADER, "Dune"]);
    const { hashLine } = await import("./lines");
    await s.db.insert(intakeLog).values({ lineHash: await hashLine("Dune"), rawLine: "Dune", source: "gdoc", createdAt: "2026-11-12T16:00:00.000Z" });
    const r = await s.run();
    expect(r).toMatchObject({ cleared: true, ingest: { created: 1, accepted: 1, skippedDuplicates: 0 } });
    expect((await s.db.select().from(mediaItems)).map((x) => x.title)).toEqual(["T:Dune"]);
    expect(await s.db.select().from(intakeLog)).toHaveLength(1);
  });

  it("sends no delete and rethrows when Gemini fails", async () => {
    const s = await sweepSetup([HEADER, "Dune"], { gemini: jsonResponse({}, 503) });
    await expect(s.run()).rejects.toMatchObject({ name: "GeminiError", status: 503 });
    expect(batchCalls(s.f)).toHaveLength(0);
    expect(await s.db.select().from(intakeLog)).toHaveLength(0);
  });
});

describe("POST /api/webhook/intake", () => {
  afterEach(() => vi.unstubAllGlobals());

  function build(over: { secret?: string | null; gemini?: Parameters<typeof createFakeFetch>[0][string] } = {}) {
    const { db, d1 } = setup();
    const f = createFakeFetch({ [GEMINI_URL]: over.gemini ?? echoGemini });
    vi.stubGlobal("fetch", f.fetchImpl);
    const app = new Hono();
    app.route("/", createIntakeRoutes());
    const env: Record<string, unknown> = { DB: d1, GEMINI_API_KEY: GEMINI_KEY };
    if (over.secret !== null) env.WEBHOOK_SECRET = over.secret ?? WEBHOOK_SECRET;
    const post = (body: unknown, auth: string | null = `Bearer ${WEBHOOK_SECRET}`, raw = false) =>
      app.request(
        "/api/webhook/intake",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body: raw ? (body as string) : JSON.stringify(body),
        },
        env,
      );
    return { db, f, post };
  }

  async function noLeak(res: Response | string) {
    const t = typeof res === "string" ? res : await res.clone().text();
    expect(t).not.toContain(WEBHOOK_SECRET);
    expect(t).not.toContain(GEMINI_KEY);
  }

  it("401 with no or wrong bearer", async () => {
    const { post, f } = build();
    for (const auth of [null, "Bearer nope", "Basic abc", `Bearer ${WEBHOOK_SECRET}x`]) {
      const res = await post({ text: "Dune" }, auth);
      expect(res.status).toBe(401);
      await noLeak(res);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("503 when no secret is configured, even with a matching-looking header", async () => {
    const { post } = build({ secret: null });
    const res = await post({ text: "Dune" }, "Bearer ");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect((await post({ text: "Dune" }, "Bearer undefined")).status).toBe(503);
  });

  it("400 on bad bodies", async () => {
    const { post } = build();
    expect((await post("{not json", undefined, true)).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: 5 })).status).toBe(400);
    expect((await post({ text: "  \n " })).status).toBe(400);
  });

  it("413 over 25 lines or 20,000 characters", async () => {
    const { post, f } = build();
    const many = Array.from({ length: 26 }, (_, i) => `l${i}`).join("\n");
    const r1 = await post({ text: many });
    expect(r1.status).toBe(413);
    expect(await r1.json()).toMatchObject({ error: "too_many_lines" });
    expect((await post({ text: "x".repeat(20_001) })).status).toBe(413);
    expect(f.calls).toHaveLength(0);
  });

  it("200 happy path ingests and returns the result", async () => {
    const { post, db } = build();
    const res = await post({ text: "Dune\n\nAlien", source: "ignored" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ accepted: 2, created: 2, merged: 0, remaining: 0 });
    await noLeak(text);
    expect(await db.select().from(mediaItems)).toHaveLength(2);
    expect((await db.select().from(intakeLog))[0]!.source).toBe("webhook");
    expect(await db.select().from(activityLog)).toHaveLength(2);
  });

  it("502 parser_unavailable when Gemini fails, writing nothing", async () => {
    const { post, db } = build({ gemini: jsonResponse({}, 500) });
    const res = await post({ text: "Dune" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "parser_unavailable" });
    await noLeak(text);
    expect(await db.select().from(mediaItems)).toHaveLength(0);
    expect(await db.select().from(intakeLog)).toHaveLength(0);
  });

  it("accepts exactly 25 lines", async () => {
    const { post } = build({ gemini: () => geminiBody([item()]) });
    const text = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    expect((await post({ text })).status).toBe(200);
  });
});
