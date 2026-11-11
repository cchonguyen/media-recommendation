import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { systemKv } from "../db/schema";
import { signServiceAccountJwt, GOOGLE_TOKEN_URL } from "./jwt";
import type { SubrequestBudget } from "./api";

export type Db = ReturnType<typeof drizzle>;

export interface GoogleEnv {
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
}

export const GOOGLE_TOKEN_CACHE_KEY = "google_access_token";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];

/** Carries only the HTTP status and Google's error code, never secrets. */
export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export async function getCachedValue(db: Db, key: string, nowSeconds: number): Promise<string | null> {
  const rows = await db.select().from(systemKv).where(eq(systemKv.key, key)).limit(1);
  const row = rows[0];
  return row && row.expiresAt > nowSeconds ? row.value : null;
}

export async function setCachedValue(db: Db, key: string, value: string, expiresAtSeconds: number): Promise<void> {
  await db
    .insert(systemKv)
    .values({ key, value, expiresAt: expiresAtSeconds })
    .onConflictDoUpdate({ target: systemKv.key, set: { value, expiresAt: expiresAtSeconds } });
}

export interface GetTokenInput {
  db: Db;
  env: GoogleEnv;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
  budget?: SubrequestBudget;
}

export async function getGoogleAccessToken(input: GetTokenInput): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const cached = await getCachedValue(input.db, GOOGLE_TOKEN_CACHE_KEY, now);
  if (cached) return cached;

  const email = input.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pem = input.env.GOOGLE_PRIVATE_KEY;
  if (!email) throw new GoogleAuthError("Missing env var GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!pem) throw new GoogleAuthError("Missing env var GOOGLE_PRIVATE_KEY");

  const assertion = await signServiceAccountJwt({
    email,
    privateKeyPem: pem,
    scopes: GOOGLE_SCOPES,
    nowSeconds: now,
  });

  input.budget?.take();
  const res = await (input.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  let payload: { access_token?: string; expires_in?: number; error?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // Non-JSON body: fall through with status only.
  }
  if (!res.ok) {
    const code = typeof payload.error === "string" ? payload.error : undefined;
    throw new GoogleAuthError(
      `Google token exchange failed: HTTP ${res.status}${code ? ` ${code}` : ""}`,
      res.status,
      code,
    );
  }
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new GoogleAuthError("Google token response missing access_token or expires_in", res.status);
  }
  const ttl = Math.min(3300, payload.expires_in - 300);
  await setCachedValue(input.db, GOOGLE_TOKEN_CACHE_KEY, payload.access_token, now + ttl);
  return payload.access_token;
}
