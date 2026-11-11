// Test-only helpers. Never imported by production code.
import { mediaItems } from "../db/schema";
import type { NewMediaItem } from "../db/schema";
import { createFakeFetch, createTestD1, createTestDb, jsonResponse } from "../google/test-helpers";
import type { FakeHandler } from "../google/test-helpers";

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";
export const GEMINI_KEY = "test-gemini-key-SECRET";
export const WEBHOOK_SECRET = "test-webhook-secret-SECRET";
export const FIXED_NOW = new Date("2026-07-01T19:00:00Z");

/** D1 batches are transactional. node:sqlite is one connection, so emulate with BEGIN/COMMIT and a queue. */
export function createTransactionalD1(): D1Database {
  const d1 = createTestD1() as unknown as {
    prepare: (sql: string) => { run: () => Promise<unknown> };
    batch: (s: { run: () => Promise<unknown> }[]) => Promise<unknown[]>;
  };
  let chain: Promise<unknown> = Promise.resolve();
  d1.batch = (stmts) => {
    const task = chain.then(async () => {
      await d1.prepare("BEGIN").run();
      try {
        const out: unknown[] = [];
        for (const s of stmts) out.push(await s.run());
        await d1.prepare("COMMIT").run();
        return out;
      } catch (e) {
        await d1.prepare("ROLLBACK").run();
        throw e;
      }
    });
    chain = task.catch(() => undefined);
    return task;
  };
  return d1 as unknown as D1Database;
}

export function setup() {
  const d1 = createTransactionalD1();
  return { d1, db: createTestDb(d1) };
}

export function geminiBody(items: unknown[]): Response {
  return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items }) }] } }] });
}

export function item(over: Record<string, unknown> = {}) {
  return {
    lineIndex: 0,
    title: "Dune",
    yearHint: null,
    mediaType: "Movie",
    isAlreadyConsumed: false,
    recommenderName: "Self",
    trustWeight: 3,
    myRating: null,
    consumedYear: null,
    personalNotes: "",
    alternativeMatchesNote: "",
    ...over,
  };
}

export function geminiFetch(handler: FakeHandler | Response, extra: Record<string, FakeHandler | Response> = {}) {
  return createFakeFetch({ [GEMINI_URL]: handler, ...extra });
}

/** One Movie item per input line, titled "T:<line>". Reads the numbered lines from the prompt. */
export const echoGemini: FakeHandler = (call) => {
  const prompt = JSON.parse(call.body ?? "{}").contents[0].parts[0].text as string;
  const lines = prompt.split("Lines:\n")[1]!.split("\n");
  return geminiBody(lines.map((l, i) => item({ lineIndex: i, title: `T:${l.replace(/^\d+: /, "")}` })));
};

type Db = ReturnType<typeof createTestDb>;

export async function seed(db: Db, over: Partial<NewMediaItem> & { id: string; title: string }) {
  const iso = "2026-01-01T00:00:00.000Z";
  await db.insert(mediaItems).values({
    rawInput: over.title,
    mediaType: "Movie",
    lastStatusChangeAt: iso,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  });
}
