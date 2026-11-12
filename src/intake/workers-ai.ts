import type { SubrequestBudget } from "../google/api";
import { buildPrompt, GeminiError, RESPONSE_SCHEMA, validateGeminiItems, type ParsedItem } from "./gemini";
import type { IntakeEnv } from "./types";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_TIMEOUT_MS = 15_000;
export const AI_GATEWAY_ID = "default";

const SYSTEM = "You extract media titles from a personal inbox into JSON. Lines that name a film, show, book, game or podcast always yield an item.";
const PLAIN_JSON_HINT =
  'Return only JSON shaped as {"items":[{"lineIndex":0,"title":"","yearHint":null,"mediaType":"Movie","isAlreadyConsumed":false,"recommenderName":"Self","trustWeight":3,"myRating":null,"consumedYear":null,"personalNotes":"","alternativeMatchesNote":""}]}.';

function isEmpty(parsed: unknown): boolean {
  const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
  return !Array.isArray(list) || list.length === 0;
}

async function runOnce(
  ai: NonNullable<IntakeEnv["AI"]>,
  input: { budget?: SubrequestBudget },
  responseFormat: unknown,
  prompt: string,
): Promise<unknown> {
  input.budget?.take();
  let out: unknown;
  try {
    out = await Promise.race([
      ai.run(WORKERS_AI_MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        response_format: responseFormat,
        temperature: 0,
        max_tokens: 4096,
      }, { gateway: { id: AI_GATEWAY_ID, skipCache: true } }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), WORKERS_AI_TIMEOUT_MS)),
    ]);
  } catch (e) {
    throw new GeminiError(`Workers AI failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`, 502);
  }
  // The binding returns { response } where response is an object (JSON mode) or a JSON string.
  const resp = (out as { response?: unknown } | null)?.response;
  let parsed: unknown = resp;
  if (typeof resp === "string") {
    try {
      parsed = JSON.parse(resp);
    } catch {
      throw new GeminiError("Workers AI response was not parseable JSON", 502);
    }
  }
  if (!parsed || typeof parsed !== "object") throw new GeminiError("Workers AI returned no result", 502);
  return parsed;
}

/** Same contract as parseLinesWithGemini. Failures throw GeminiError so callers handle one type. */
export async function parseLinesWithWorkersAI(input: {
  lines: string[];
  env: IntakeEnv;
  budget?: SubrequestBudget;
}): Promise<{ items: ParsedItem[]; rejected: number; diag: string }> {
  const ai = input.env.AI;
  if (!ai) throw new GeminiError("Workers AI is not bound", 0);
  const first = await runOnce(ai, input, { type: "json_schema", json_schema: toJsonSchema() }, buildPrompt(input.lines));
  let parsed = first;
  if (input.lines.length > 0 && isEmpty(first)) {
    // Schema-constrained decoding can collapse to an empty list. Ask once more in plain JSON mode.
    const retry = await runOnce(ai, input, { type: "json_object" }, `${buildPrompt(input.lines)}\n\n${PLAIN_JSON_HINT}`).catch(() => null);
    if (retry && !isEmpty(retry)) parsed = retry;
  }
  const result = validateGeminiItems(normalizeShape(parsed, input.lines.length), input.lines.length);
  const diag =
    `Workers AI returned ${result.items.length} usable items, ${result.rejected} rejected` +
    (result.reasons.length ? ` (${result.reasons.slice(0, 3).join("; ")})` : "") +
    (result.items.length === 0 ? `; raw: ${JSON.stringify(parsed).slice(0, 200)}` : "");
  if (result.items.length === 0 && input.lines.length > 0) console.warn(diag);
  return { items: result.items, rejected: result.rejected, diag };
}

/** Models drift from the schema: accept a bare array, and line numbers counted from 1. */
export function normalizeShape(parsed: unknown, lineCount: number): unknown {
  const wrapped = Array.isArray(parsed) ? { items: parsed } : parsed;
  const items = (wrapped as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return wrapped;
  // A model without null support fills unknowns with placeholders such as 0. Those mean "unknown".
  for (const i of items) {
    if (!i || typeof i !== "object") continue;
    const r = i as Record<string, unknown>;
    for (const k of ["yearHint", "consumedYear"]) {
      if (typeof r[k] === "number" && (r[k] < 1800 || r[k] > 2100)) r[k] = null;
    }
    if (typeof r.myRating === "number" && (r.myRating < 1 || r.myRating > 5)) r.myRating = null;
  }
  const idx = items.map((i) => (i as { lineIndex?: unknown } | null)?.lineIndex).filter((n): n is number => Number.isInteger(n));
  if (idx.length > 0 && Math.min(...idx) >= 1 && Math.max(...idx) === lineCount) {
    return {
      items: items.map((i) =>
        i && typeof i === "object" && Number.isInteger((i as { lineIndex?: unknown }).lineIndex)
          ? { ...(i as object), lineIndex: (i as { lineIndex: number }).lineIndex - 1 }
          : i,
      ),
    };
  }
  return wrapped;
}

/** Workers AI wants lowercase JSON Schema types. */
export function toJsonSchema(): unknown {
  const lower = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(lower);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        // "nullable" is Gemini's dialect. JSON Schema needs a type union, or the model must invent a number.
        if (k === "nullable") continue;
        if (k === "type" && typeof v === "string") out[k] = o.nullable === true ? [v.toLowerCase(), "null"] : v.toLowerCase();
        else out[k] = lower(v);
      }
      return out;
    }
    return n;
  };
  return lower(RESPONSE_SCHEMA);
}
