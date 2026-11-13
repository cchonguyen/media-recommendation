import { drizzle } from "drizzle-orm/d1";
import { and, gt, inArray, ne, sql } from "drizzle-orm";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { mediaItems, systemKv } from "../db/schema";
import { LAST_INBOX_SYNC_KEY } from "../api/time";
import { LAST_BACKUP_KEY } from "../backup/export";
import { CLIENT_SCRIPT } from "./client";
import { STYLES } from "./styles";
import { Icon, FAVICON_HREF } from "./icons";
import { Pill } from "./controls";

export interface StatusStrip {
  lastSync: string | null;
  lastBackup: string | null;
  pending: number;
  failed: number;
}

export const DESTINATIONS = [
  { key: "now", label: "Now & Next", short: "Now", href: "/", icon: "play", keys: ["now"], eyebrow: "Today" },
  { key: "library", label: "Library", short: "Library", href: "/library/movies", icon: "library", keys: ["movies", "tv", "books", "games", "podcasts", "one-offs"], eyebrow: "Library" },
  { key: "completed", label: "Completed Archive", short: "Archive", href: "/library/completed", icon: "archive", keys: ["completed"], eyebrow: "Archive" },
  { key: "lists", label: "Lists", short: "Lists", href: "/lists", icon: "list-ordered", keys: ["lists"], eyebrow: "Curated" },
] as const;

/** Same logic as GET /api/status: one aggregate plus the cached sync stamp. */
export async function loadStatusStrip(d1: D1Database, now: Date): Promise<StatusStrip> {
  const db = drizzle(d1);
  const [agg, last] = await Promise.all([
    db
      .select({
        pending: sql<number>`coalesce(sum(case when ${mediaItems.enrichmentStatus} = 'PENDING' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${mediaItems.enrichmentStatus} = 'FAILED' then 1 else 0 end), 0)`,
      })
      .from(mediaItems)
      .where(ne(mediaItems.status, "Archived")),
    // One query for both stamps keeps the D1 read count unchanged.
    db
      .select()
      .from(systemKv)
      .where(and(inArray(systemKv.key, [LAST_INBOX_SYNC_KEY, LAST_BACKUP_KEY]), gt(systemKv.expiresAt, Math.floor(now.getTime() / 1000)))),
  ]);
  const kv = new Map(last.map((r) => [r.key, r.value]));
  return {
    lastSync: kv.get(LAST_INBOX_SYNC_KEY) ?? null,
    lastBackup: kv.get(LAST_BACKUP_KEY) ?? null,
    pending: Number(agg[0]?.pending ?? 0),
    failed: Number(agg[0]?.failed ?? 0),
  };
}

export function formatSync(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function Layout(props: { active: string; status: StatusStrip; title?: string; heading?: string; children?: Child }) {
  const { active, status, heading } = props;
  const isCurrent = (d: (typeof DESTINATIONS)[number]) => (d.keys as readonly string[]).includes(active);
  const eyebrow = DESTINATIONS.find(isCurrent)?.eyebrow ?? "Media Tracker";
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en" data-accent="azure" data-density="comfortable">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="dark light" />
          <title>{props.title ?? "Media Tracker"}</title>
          <link rel="icon" href={FAVICON_HREF} />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" />
          <style>{raw(STYLES)}</style>
        </head>
        <body>
          <div class="ui-shell">
            <nav class="ui-sidebar" aria-label="Sections">
              <div class="ui-sidebar__brand">
                <span class="ui-appmark">
                  <Icon name="film" />
                </span>
                Media Tracker
              </div>
              {DESTINATIONS.map((d) => (
                <a class="ui-nav-item" href={d.href} aria-current={isCurrent(d) ? "page" : undefined}>
                  <Icon name={d.icon} />
                  {d.label}
                </a>
              ))}
            </nav>
            <main class="ui-main" id="main">
              <div class="app-page">
                {heading ? (
                  <header class="app-head">
                    <span class="ui-eyebrow">{eyebrow}</span>
                    <h1 class="ui-display app-title">{heading}</h1>
                  </header>
                ) : null}
                <section class="ui-card app-status" aria-label="Inbox status">
                  <span class="ui-data">Last inbox sync: {formatSync(status.lastSync)}</span>
                  <Pill tone="mid" icon="clock">
                    Pending enrichment: {status.pending}
                  </Pill>
                  {status.failed > 0 ? (
                    <Pill tone="bad" icon="alert-circle">
                      Failed: {status.failed}
                    </Pill>
                  ) : (
                    <Pill>Failed: 0</Pill>
                  )}
                  <span class="app-status__grow" />
                  <button type="button" class="ui-btn" data-action="sweep">
                    <Icon name="refresh-cw" />
                    Sweep Inbox Now
                  </button>
                  <span class="ui-data" id="last-backup">Last backup: {formatSync(status.lastBackup)}</span>
                  <button type="button" class="ui-btn" data-action="backup">
                    <Icon name="download" />
                    Backup to Google Sheets
                  </button>
                </section>
                <div id="notices" class="app-notices" />
                {props.children}
                {active === "now" ? (
                  <section class="app-section" aria-labelledby="h-sweeps">
                    <h2 class="ui-display app-h2" id="h-sweeps">Last sweeps</h2>
                    <div class="app-actions">
                      <button type="button" class="ui-btn" data-action="test-parse">
                        <Icon name="search" />
                        Test parse
                      </button>
                    </div>
                    <div id="sweeps" class="app-stack" />
                    <div id="test-parse-result" class="app-stack" />
                  </section>
                ) : null}
              </div>
            </main>
            <nav class="ui-tabbar" aria-label="Sections (mobile)">
              {DESTINATIONS.map((d) => (
                <a class="ui-tab" href={d.href} aria-current={isCurrent(d) ? "page" : undefined}>
                  <Icon name={d.icon} size={20} />
                  {d.short}
                </a>
              ))}
            </nav>
          </div>
          <div class="ui-toasts" id="toasts" aria-live="polite" />
          <script>{raw(CLIENT_SCRIPT)}</script>
        </body>
      </html>
    </>
  );
}
