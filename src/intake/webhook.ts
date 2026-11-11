import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { GeminiError } from "./gemini";
import { MAX_LINES_PER_RUN, splitLines } from "./lines";
import { ingestRawLines } from "./ingest";
import type { IntakeEnv } from "./types";

export const MAX_BODY_CHARS = 20_000;

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time compare: hash both sides, then XOR the equal-length digests. */
export async function secureEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

export function createIntakeRoutes() {
  const routes = new Hono<{ Bindings: IntakeEnv & { DB: D1Database } }>();

  routes.post("/api/webhook/intake", async (c) => {
    const secret = c.env.WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not_configured" }, 503);

    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(header);
    if (!m || !(await secureEquals(m[1]!, secret))) return c.json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.trim() === "") return c.json({ error: "invalid_body" }, 400);

    const lines = splitLines(text);
    if (text.length > MAX_BODY_CHARS || lines.length > MAX_LINES_PER_RUN) {
      return c.json({ error: "too_many_lines", message: `Send at most ${MAX_LINES_PER_RUN} lines per request.` }, 413);
    }

    try {
      const result = await ingestRawLines({ db: drizzle(c.env.DB), env: c.env }, lines, "webhook");
      return c.json(result, 200);
    } catch (e) {
      if (e instanceof GeminiError) return c.json({ error: "parser_unavailable" }, 502);
      console.error("webhook intake failed", e instanceof Error ? e.name : "unknown");
      return c.json({ error: "internal_error" }, 500);
    }
  });

  return routes;
}
