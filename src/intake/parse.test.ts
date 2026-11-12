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
});
