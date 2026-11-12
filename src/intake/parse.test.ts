import { describe, expect, it } from "vitest";
import { GeminiError } from "./gemini";
import { parseLines } from "./parse";
import { WORKERS_AI_MODEL } from "./workers-ai";
import { GEMINI_KEY, geminiBody, item } from "./test-fixtures";
import type { AiBinding } from "./types";

function ai(run: AiBinding["run"]) {
  const calls: unknown[] = [];
  return { binding: { run: async (m: string, i: unknown, o?: unknown) => (calls.push([m, i, o]), run(m, i, o as never)) } as AiBinding, calls };
}
function gemini() {
  let n = 0;
  const fetchImpl = (async () => (n++, geminiBody([item({ title: "FromGemini" })]))) as typeof fetch;
  return { fetchImpl, count: () => n };
}
const lines = ["Dune"];

describe("parseLines", () => {
  it("uses Workers AI first and never calls Gemini when it works", async () => {
    const a = ai(async () => ({ response: { items: [item({ title: "FromAI" })] } }));
    const g = gemini();
    const out = await parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("FromAI");
    expect(g.count()).toBe(0);
    expect((a.calls[0] as [string])[0]).toBe(WORKERS_AI_MODEL);
  });

  it("accepts a JSON string response", async () => {
    const a = ai(async () => ({ response: JSON.stringify({ items: [item({ title: "Str" })] }) }));
    const out = await parseLines({ lines, env: { AI: a.binding } });
    expect(out.items[0]!.title).toBe("Str");
  });

  it("falls back to Gemini when Workers AI throws", async () => {
    const a = ai(async () => {
      throw new Error("daily limit");
    });
    const g = gemini();
    const out = await parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("FromGemini");
    expect(g.count()).toBe(1);
  });

  it("falls back to Gemini on unparseable output", async () => {
    const a = ai(async () => ({ response: "not json" }));
    const g = gemini();
    const out = await parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("FromGemini");
  });

  it("uses Gemini directly when no AI binding exists", async () => {
    const g = gemini();
    const out = await parseLines({ lines, env: { GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("FromGemini");
  });

  it("throws a GeminiError when both fail", async () => {
    const a = ai(async () => {
      throw new Error("down");
    });
    await expect(parseLines({ lines, env: { AI: a.binding } })).rejects.toBeInstanceOf(GeminiError);
  });

  it("accepts a bare array and line numbers counted from 1", async () => {
    const a = ai(async () => ({ response: [item({ lineIndex: 1, title: "A" }), item({ lineIndex: 2, title: "B" })] }));
    const out = await parseLines({ lines: ["a", "b"], env: { AI: a.binding } });
    expect(out.items.map((i) => [i.lineIndex, i.title])).toEqual([[0, "A"], [1, "B"]]);
  });

  it("falls back to Gemini when Workers AI returns no items", async () => {
    const a = ai(async () => ({ response: { items: [] } }));
    const g = gemini();
    const out = await parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("FromGemini");
  });

  it("throws Gemini's error when Workers AI is empty and Gemini fails", async () => {
    const a = ai(async () => ({ response: { items: [] } }));
    const bad = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    await expect(
      parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: bad, sleep: async () => {} }),
    ).rejects.toMatchObject({ name: "GeminiError", status: 429 });
  });

  it("sends Workers AI a real nullable JSON Schema", async () => {
    const { toJsonSchema } = await import("./workers-ai");
    const props = (toJsonSchema() as { properties: { items: { items: { properties: Record<string, Record<string, unknown>> } } } }).properties.items.items.properties;
    expect(props.yearHint).toEqual({ type: ["integer", "null"] });
    expect(props.myRating).toEqual({ type: ["number", "null"] });
    expect(props.title).toEqual({ type: "string" });
  });

  it("treats placeholder years and ratings from Workers AI as unknown", async () => {
    const a = ai(async () => ({ response: { items: [item({ yearHint: 0, myRating: 0, consumedYear: 0 })] } }));
    const out = await parseLines({ lines, env: { AI: a.binding } });
    expect(out).toMatchObject({ rejected: 0, items: [{ title: "Dune", yearHint: null, myRating: null, consumedYear: null }] });
  });

  it("makes a single Gemini attempt after an empty Workers AI result", async () => {
    const a = ai(async () => ({ response: { items: [] } }));
    let n = 0;
    const bad = (async () => (n++, new Response("{}", { status: 503 }))) as typeof fetch;
    await expect(
      parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: bad, sleep: async () => {} }),
    ).rejects.toMatchObject({ status: 503 });
    expect(n).toBe(1);
  });

  it("names the Workers AI reason when both parsers fail", async () => {
    const bad = (async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as typeof fetch;
    const empty = ai(async () => ({ response: { items: [item({ mediaType: "Anime" })] } }));
    const e1 = await parseLines({ lines, env: { AI: empty.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: bad }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ name: "GeminiError", status: 429 });
    expect((e1 as GeminiError).detail).toContain("quota");
    expect((e1 as GeminiError).detail).toContain('bad mediaType "Anime"');
    const boom = ai(async () => {
      throw new Error("JSON Mode couldn't be met");
    });
    const e2 = await parseLines({ lines, env: { AI: boom.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: bad, sleep: async () => {} }).catch((e: unknown) => e);
    expect((e2 as GeminiError).detail).toContain("JSON Mode couldn't be met");
  });

  it("parses template lines without calling any model", async () => {
    const a = ai(async () => ({ response: { items: [] } }));
    const g = gemini();
    const out = await parseLines({
      lines: ["Severance (TV) | Recommender: Self | Notes: ", "Hacks (TV) | Status: Completed | Consumed: 2026 | Recommender: Self | Notes: Just finished"],
      env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY },
      fetchImpl: g.fetchImpl,
    });
    expect(out.items.map((i) => [i.lineIndex, i.title])).toEqual([[0, "Severance"], [1, "Hacks"]]);
    expect(a.calls).toHaveLength(0);
    expect(g.count()).toBe(0);
  });

  it("sends only free-form lines to the model and maps their line numbers back", async () => {
    const a = ai(async () => ({ response: { items: [item({ lineIndex: 0, title: "Look Back" })] } }));
    const out = await parseLines({ lines: ["Severance (TV) | Notes: x", "Look Back (2026) | Recommender: Self"], env: { AI: a.binding } });
    expect(out.items.map((i) => [i.lineIndex, i.title])).toEqual([[0, "Severance"], [1, "Look Back"]]);
    const prompt = ((a.calls[0] as [string, { messages: { content: string }[] }])[1].messages[1]!).content;
    expect(prompt).toContain("0: Look Back (2026)");
    expect(prompt).not.toContain("Severance");
  });

  it("keeps template lines when every model fails", async () => {
    const a = ai(async () => {
      throw new Error("down");
    });
    const out = await parseLines({ lines: ["Severance (TV) | Notes: x", "some free text"], env: { AI: a.binding } });
    expect(out).toMatchObject({ degraded: true, items: [{ title: "Severance" }] });
    expect(out.diag).toContain("models FAILED for 1 free-form lines");
  });

  it("retries Workers AI in plain JSON mode after an empty schema answer", async () => {
    let n = 0;
    const a = ai(async () => (n++ === 0 ? { response: { items: [] } } : { response: { items: [item({ title: "Second" })] } }));
    const g = gemini();
    const out = await parseLines({ lines, env: { AI: a.binding, GEMINI_API_KEY: GEMINI_KEY }, fetchImpl: g.fetchImpl });
    expect(out.items[0]!.title).toBe("Second");
    expect(g.count()).toBe(0);
    expect((a.calls[1] as [string, { response_format: unknown }])[1].response_format).toEqual({ type: "json_object" });
    const opts = { gateway: { id: "default", skipCache: true } };
    expect((a.calls[0] as unknown[])[2]).toEqual(opts);
    expect((a.calls[1] as unknown[])[2]).toEqual(opts);
  });
});
