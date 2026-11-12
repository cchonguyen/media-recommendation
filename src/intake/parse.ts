import { parseLinesWithGemini, GeminiError, type ParseInput, type ParsedItem } from "./gemini";
import { parseLinesWithWorkersAI } from "./workers-ai";

/**
 * Workers AI first (no API key, free daily allowance), Gemini when it fails or is not bound.
 * Both failing throws Gemini's error so callers keep one error type.
 */
export interface ParseResult {
  items: ParsedItem[];
  rejected: number;
  /** One line on what the parsers did, for the operator and for system_kv. */
  diag?: string;
}

/** Gemini's error, with the Workers AI reason attached so one message names both failures. */
function withWorkersAi(e: unknown, waDiag: string): unknown {
  if (!(e instanceof GeminiError)) return e;
  const detail = [e.detail, waDiag].filter(Boolean).join(" | ").slice(0, 600);
  return new GeminiError(e.message, e.status, detail);
}

export async function parseLines(input: ParseInput): Promise<ParseResult> {
  if (!input.env.AI) return parseLinesWithGemini(input);
  let out: ParseResult;
  try {
    out = await parseLinesWithWorkersAI({ lines: input.lines, env: input.env, budget: input.budget });
  } catch (e) {
    if (!(e instanceof GeminiError)) throw e;
    console.warn("Workers AI parse failed, falling back to Gemini:", e.message);
    try {
      return await parseLinesWithGemini(input);
    } catch (ge) {
      throw withWorkersAi(ge, e.message);
    }
  }
  // Nothing usable from a non-empty batch means the model misfired: let Gemini try before giving up.
  if (out.items.length > 0 || input.lines.length === 0 || !input.env.GEMINI_API_KEY) return out;
  // One attempt only: Workers AI already used part of the request's time. A failure is thrown,
  // not swallowed, so the sweep names the real reason.
  try {
    return await parseLinesWithGemini({ ...input, maxRetries: 0 });
  } catch (ge) {
    throw withWorkersAi(ge, out.diag ?? "");
  }
}
