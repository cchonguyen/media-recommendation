import { parseLinesWithGemini, GeminiError, type ParseInput, type ParsedItem } from "./gemini";
import { parseLinesWithWorkersAI } from "./workers-ai";

/**
 * Workers AI first (no API key, free daily allowance), Gemini when it fails or is not bound.
 * Both failing throws Gemini's error so callers keep one error type.
 */
export async function parseLines(input: ParseInput): Promise<{ items: ParsedItem[]; rejected: number }> {
  if (input.env.AI) {
    try {
      return await parseLinesWithWorkersAI({ lines: input.lines, env: input.env, budget: input.budget });
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      console.warn("Workers AI parse failed, falling back to Gemini:", e.message);
    }
  }
  return parseLinesWithGemini(input);
}
