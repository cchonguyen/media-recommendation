import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { exportToSheets, safeBackupError } from "./export";
import type { BackupDeps, BackupEnv, BackupResult } from "./export";

export interface BackupRouteOptions {
  now?: () => Date;
  exporter?: (deps: BackupDeps) => Promise<BackupResult>;
}

type RouteEnv = BackupEnv & { DB: D1Database };

export function createBackupRoutes(opts: BackupRouteOptions = {}) {
  const app = new Hono<{ Bindings: RouteEnv }>();
  const exporter = opts.exporter ?? exportToSheets;

  app.post("/backup", async (c) => {
    try {
      const result = await exporter({ db: drizzle(c.env.DB), env: c.env, now: opts.now });
      if ("skipped" in result) {
        return c.json({ error: "not_configured", message: "Backup sheet or Google credentials are not configured." }, 503);
      }
      return c.json(result, 200);
    } catch (e) {
      const safe = safeBackupError(e);
      console.error("backup failed", e instanceof Error ? e.name : "Error");
      return c.json({ error: safe.error, message: safe.message }, safe.status);
    }
  });

  return app;
}
