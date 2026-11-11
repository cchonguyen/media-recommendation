import type { SubrequestBudget } from "../google/api";
import type { Db } from "../google/token";

export interface IntakeEnv {
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
