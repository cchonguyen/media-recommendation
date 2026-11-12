import type { SubrequestBudget } from "../google/api";
import type { Db } from "../google/token";

/** Cloudflare Workers AI binding, reduced to the one call used here. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface IntakeEnv {
  /** Keyless primary parser. Optional so tests and local runs work without it. */
  AI?: AiBinding;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  INBOX_DOC_ID?: string;
  WEBHOOK_SECRET?: string;
}

export interface IngestDeps {
  db: Db;
  env: IntakeEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now?: () => Date;
}
