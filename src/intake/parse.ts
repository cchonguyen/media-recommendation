import { parseLinesWithGemini, GeminiError, type ParseInput, type ParsedItem } from "./gemini";
import { parseStructuredLine } from "./structured";
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
  /** True when a model failed but template lines were still parsed. */
  degraded?: boolean;
}

/** Gemini's error, with the Workers AI reason attached so one message names both failures. */
function withWorkersAi(e: unknown, waDiag: string): unknown {
  if (!(e instanceof GeminiError)) return e;
  const detail = [e.detail, waDiag].filter(Boolean).join(" | ").slice(0, 600);
  return new GeminiError(e.message, e.status, detail);
}

async function parseWithModels(input: ParseInput): Promise<ParseResult> {
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

/**
 * Template lines are parsed locally and never reach a model. Only free-form lines do, and a model
 * failure there does not discard the template lines: those are returned and the rest stay unparsed.
 */
export async function parseLines(input: ParseInput): Promise<ParseResult> {
  const structured: ParsedItem[] = [];
  const rest: { line: string; index: number }[] = [];
  input.lines.forEach((line, index) => {
    const it = parseStructuredLine(line, index);
    if (it) structured.push(it);
    else rest.push({ line, index });
  });
  if (structured.length === 0) return parseWithModels(input);
  const note = `template parser read ${structured.length} of ${input.lines.length} lines`;
  if (rest.length === 0) return { items: structured, rejected: 0, diag: note };
  try {
    const out = await parseWithModels({ ...input, lines: rest.map((r) => r.line) });
    const mapped = out.items.map((it) => ({ ...it, lineIndex: rest[it.lineIndex]!.index }));
    return { items: [...structured, ...mapped], rejected: out.rejected, diag: [note, out.diag].filter(Boolean).join("; ") };
  } catch (e) {
    if (!(e instanceof GeminiError)) throw e;
    const why = `${e.message}${e.detail ? ` | ${e.detail}` : ""}`;
    console.warn("Models failed for free-form lines:", why);
    return { items: structured, rejected: 0, degraded: true, diag: `${note}; models FAILED for ${rest.length} free-form lines: ${why}` };
  }
}
