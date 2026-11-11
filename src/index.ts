import { Hono } from "hono";

export type Env = {
  DB: D1Database;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GEMINI_API_KEY?: string;
  TMDB_API_KEY?: string;
  OMDB_API_KEY?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  WEBHOOK_SECRET?: string;
  INBOX_DOC_ID?: string;
  BACKUP_SHEET_ID?: string;
  GEMINI_MODEL?: string;
};

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

export async function scheduled(
  controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  switch (controller.cron) {
    case "*/15 * * * *":
      // Filled by later slices: inbox sweep, then drip enrichment queue.
      break;
    case "0 10 * * *":
      // Filled by later slices: Sheets backup and nightly grooming.
      break;
    default:
      break;
  }
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
