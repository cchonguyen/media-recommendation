import { ENRICHMENT_STATUSES, MEDIA_TYPES, STATUSES, TIERS } from "../db/schema";

export type MediaType = (typeof MEDIA_TYPES)[number];
export type Status = (typeof STATUSES)[number];
export type Tier = (typeof TIERS)[number];

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 502,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const MAX_TEXT = 10_000;
export const MAX_TITLE = 300;
export const MAX_URL = 2_000;
export const MAX_ID = 100;

export const isMediaType = (v: unknown): v is MediaType => (MEDIA_TYPES as readonly unknown[]).includes(v);
export const isStatus = (v: unknown): v is Status => (STATUSES as readonly unknown[]).includes(v);
export const isTier = (v: unknown): v is Tier => (TIERS as readonly unknown[]).includes(v);
export const isEnrichmentStatus = (v: unknown): boolean => (ENRICHMENT_STATUSES as readonly unknown[]).includes(v);

export function invalid(field: string, message: string): ApiError {
  return new ApiError(422, "invalid_field", `${field}: ${message}`);
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_body", "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(k, "unknown field");
}

export function textField(v: unknown, field: string, opts: { max: number; nonEmpty?: boolean }): string {
  if (typeof v !== "string") throw invalid(field, "must be a string");
  const s = v.trim();
  if (opts.nonEmpty && s === "") throw invalid(field, "must not be empty");
  if (s.length > opts.max) throw invalid(field, `must be at most ${opts.max} characters`);
  return s;
}

/** Free text such as notes: kept as given (not trimmed), length-capped. */
export function freeText(v: unknown, field: string): string {
  if (typeof v !== "string") throw invalid(field, "must be a string");
  if (v.length > MAX_TEXT) throw invalid(field, `must be at most ${MAX_TEXT} characters`);
  return v;
}

export function nullableText(v: unknown, field: string, max: number): string | null {
  if (v === null) return null;
  const s = textField(v, field, { max });
  return s === "" ? null : s;
}

export function nullableUrl(v: unknown, field: string): string | null {
  const s = nullableText(v, field, MAX_URL);
  if (s === null) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw invalid(field, "must be an http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw invalid(field, "must be an http(s) URL");
  return s;
}

export function nullableExternalId(v: unknown, field: string): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return nullableText(String(v), field, MAX_ID);
  return nullableText(v, field, MAX_ID);
}

export function nullableYear(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1800 || v > 2200) {
    throw invalid(field, "must be an integer year between 1800 and 2200");
  }
  return v;
}

const TITLE_YEAR = /^(.*?)\s*\((\d{4})\)\s*$/;

/** "Dune (2021)" becomes title "Dune" and year 2021. Titles without a plausible year suffix are unchanged. */
export function splitTitleYear(title: string): { title: string; year: number | null } {
  const m = TITLE_YEAR.exec(title);
  if (!m) return { title, year: null };
  const year = Number(m[2]);
  const base = m[1]!.trim();
  if (year < 1800 || year > 2200 || base === "") return { title, year: null };
  return { title: base, year };
}

export function isValidRating(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 5 && Number.isInteger(n * 2);
}
