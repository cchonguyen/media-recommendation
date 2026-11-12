import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { sweepInboxDoc } from "./intake/doc-sweep";
import { createIntakeRoutes } from "./intake/webhook";
import { runEnrichmentQueue } from "./enrichment/queue";
import { createApiRoutes } from "./api/routes";
import { recordInboxSync } from "./api/time";

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
app.route("/", createIntakeRoutes());
app.route("/api", createApiRoutes());

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  switch (controller.cron) {
    case "*/15 * * * *":
      // Inbox sweep, then the drip enrichment queue. Each has its own try/catch.
      try {
        const db = drizzle(env.DB);
        const swept = await sweepInboxDoc({ db, env });
        if (!("skipped" in swept) || swept.skipped !== "no-inbox-doc") await recordInboxSync(db, new Date());
      } catch (e) {
        // Only name and message are logged: neither carries secrets.
        const err = e instanceof Error ? e : new Error(String(e));
        console.error("inbox sweep failed", err.name, err.message);
      }
      try {
        await runEnrichmentQueue({ db: drizzle(env.DB), env });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error("enrichment queue failed", err.name, err.message);
      }
      break;
    case "0 10 * * *":
      // Filled by later slices: Sheets backup and nightly grooming.
      break;
    default:
      break;
  }
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
