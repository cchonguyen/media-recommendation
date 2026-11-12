import { parseLinesWithGemini, GeminiError, type ParseInput, type ParsedItem } from "./gemini";
import { parseLinesWithWorkersAI } from "./workers-ai";

/**
 * Workers AI first (no API key, free daily allowance), Gemini when it fails or is not bound.
 * Both failing throws Gemini's error so callers keep one error type.
 */
export async function parseLines(input: ParseInput): Promise<{ items: ParsedItem[]; rejected: number }> {
  if (!input.env.AI) return parseLinesWithGemini(input);
  let out: { items: ParsedItem[]; rejected: number } | undefined;
  try {
    out = await parseLinesWithWorkersAI({ lines: input.lines, env: input.env, budget: input.budget });
  } catch (e) {
    if (!(e instanceof GeminiError)) throw e;
    console.warn("Workers AI parse failed, falling back to Gemini:", e.message);
    return parseLinesWithGemini(input);
  }
  // Nothing usable from a non-empty batch means the model misfired: let Gemini try before giving up.
  if (out.items.length > 0 || input.lines.length === 0 || !input.env.GEMINI_API_KEY) return out;
  console.warn("Workers AI returned no items, falling back to Gemini");
  // One attempt only: Workers AI already used part of the request's time. A failure is thrown,
  // not swallowed, so the sweep names the real reason.
  return parseLinesWithGemini({ ...input, maxRetries: 0 });
}
