import { parseLinesWithGemini, GeminiError, type ParseInput, type ParsedItem } from "./gemini";
import { parseLinesWithWorkersAI } from "./workers-ai";

/**
 * Workers AI first (no API key, free daily allowance), Gemini when it fails or is not bound.
 * Both failing throws Gemini's error so callers keep one error type.
 */
export async function parseLines(input: ParseInput): Promise<{ items: ParsedItem[]; rejected: number }> {
  if (input.env.AI) {
    try {
      const out = await parseLinesWithWorkersAI({ lines: input.lines, env: input.env, budget: input.budget });
      // Nothing usable from a non-empty batch means the model misfired: let Gemini try before giving up.
      if (out.items.length > 0 || input.lines.length === 0 || !input.env.GEMINI_API_KEY) return out;
      console.warn("Workers AI returned no items, falling back to Gemini");
      try {
        return await parseLinesWithGemini(input);
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        return out;
      }
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      console.warn("Workers AI parse failed, falling back to Gemini:", e.message);
    }
  }
  return parseLinesWithGemini(input);
}
