import { describe, expect, it } from "vitest";
import { GeminiError } from "./gemini";
import { parseLines } from "./parse";
import { WORKERS_AI_MODEL } from "./workers-ai";
import { GEMINI_KEY, geminiBody, item } from "./test-fixtures";
import type { AiBinding } from "./types";

function ai(run: AiBinding["run"]) {
  const calls: unknown[] = [];
  return { binding: { run: async (m: string, i: unknown) => (calls.push([m, i]), run(m, i)) } as AiBinding, calls };
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
});
