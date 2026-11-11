import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { base64url } from "./jwt";

type SqlValue = null | number | bigint | string;

/** Minimal D1Database over node:sqlite: just what drizzle's d1 driver calls. */
export function createTestD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }

  const makeStmt = (sql: string, params: SqlValue[] = []) => {
    const stmt = {
      bind: (...args: SqlValue[]) => makeStmt(sql, args),
      run: async () => {
        const r = sqlite.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
      },
      all: async () => ({
        success: true,
        meta: {},
        results: sqlite.prepare(sql).all(...params),
      }),
      raw: async () => {
        const s = sqlite.prepare(sql);
        s.setReturnArrays(true);
        return s.all(...params);
      },
      first: async (col?: string) => {
        const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
        if (!row) return null;
        return col ? row[col] : row;
      },
    };
    return stmt;
  };

  const d1 = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return d1 as unknown as D1Database;
}

export function createTestDb(d1: D1Database = createTestD1()) {
  return drizzle(d1);
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

/** Handlers are keyed by exact URL. An unexpected URL throws so the test fails loudly. */
export function createFakeFetch(handlers: Record<string, FakeHandler | Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const h = handlers[url];
    if (!h) throw new Error(`Unexpected fetch to ${url}`);
    return typeof h === "function" ? h(call) : h.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function generateTestServiceAccount() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const lines = btoa(bin).match(/.{1,64}/g)!.join("\n");
  return {
    email: "svc@test-project.iam.gserviceaccount.com",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
    publicKey: kp.publicKey,
  };
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export { base64url };
