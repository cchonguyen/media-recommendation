import type { SubrequestBudget } from "../google/api";
import { buildPrompt, GeminiError, RESPONSE_SCHEMA, validateGeminiItems, type ParsedItem } from "./gemini";
import type { IntakeEnv } from "./types";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_TIMEOUT_MS = 20_000;

/** Same contract as parseLinesWithGemini. Failures throw GeminiError so callers handle one type. */
export async function parseLinesWithWorkersAI(input: {
  lines: string[];
  env: IntakeEnv;
  budget?: SubrequestBudget;
}): Promise<{ items: ParsedItem[]; rejected: number }> {
  const ai = input.env.AI;
  if (!ai) throw new GeminiError("Workers AI is not bound", 0);
  input.budget?.take();
  let out: unknown;
  try {
    out = await Promise.race([
      ai.run(WORKERS_AI_MODEL, {
        messages: [{ role: "user", content: buildPrompt(input.lines) }],
        response_format: { type: "json_schema", json_schema: toJsonSchema() },
        temperature: 0,
        max_tokens: 2048,
      }),
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
  return validateGeminiItems(parsed, input.lines.length);
}

/** Workers AI wants lowercase JSON Schema types. */
function toJsonSchema(): unknown {
  const lower = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(lower);
    if (n && typeof n === "object") {
      return Object.fromEntries(
        Object.entries(n).map(([k, v]) => [k, k === "type" && typeof v === "string" ? v.toLowerCase() : lower(v)]),
      );
    }
    return n;
  };
  return lower(RESPONSE_SCHEMA);
}
