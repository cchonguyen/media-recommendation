import { drizzle } from "drizzle-orm/d1";
import { ne, sql } from "drizzle-orm";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { mediaItems } from "../db/schema";
import { LAST_INBOX_SYNC_KEY } from "../api/time";
import { getCachedValue } from "../google/token";
import { CLIENT_SCRIPT } from "./client";

export interface StatusStrip {
  lastSync: string | null;
  pending: number;
  failed: number;
}

export const TABS: { label: string; href: string; key: string }[] = [
  { label: "Now & Next", href: "/", key: "now" },
  { label: "Movies", href: "/library/movie", key: "movie" },
  { label: "TV", href: "/library/tv", key: "tv" },
  { label: "Books", href: "/library/book", key: "book" },
  { label: "Games", href: "/library/game", key: "game" },
  { label: "Podcasts", href: "/library/podcast", key: "podcast" },
  { label: "One-Offs", href: "/library/one-off", key: "one-off" },
  { label: "Completed Archive", href: "/library/completed", key: "completed" },
  { label: "Lists", href: "/lists", key: "lists" },
];

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
    getCachedValue(db, LAST_INBOX_SYNC_KEY, Math.floor(now.getTime() / 1000)),
  ]);
  return { lastSync: last, pending: Number(agg[0]?.pending ?? 0), failed: Number(agg[0]?.failed ?? 0) };
}

const CSS = `
:root{--bg:#f6f6f4;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#dcdcd6;--accent:#2457c5;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#9a9aa2;--card:#1f1f23;--line:#33333a;--accent:#7aa2ff;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:.6rem 1rem;position:sticky;top:0;z-index:5}
.strip{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;font-size:.85rem;color:var(--muted)}
.strip .grow{flex:1}
nav{display:flex;gap:.25rem;overflow-x:auto;margin-top:.5rem}
nav a{padding:.35rem .7rem;border-radius:999px;color:var(--fg);text-decoration:none;white-space:nowrap;font-size:.9rem}
nav a[aria-current=page]{background:var(--accent);color:#fff}
main{max-width:60rem;margin:0 auto;padding:1rem}
h1{font-size:1.3rem;margin:.2rem 0 1rem}
h2{font-size:1.05rem;margin:1.6rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:.75rem}
.card,.row{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:.7rem}
.card{display:flex;gap:.7rem;flex-wrap:wrap}
.card img{width:56px;height:84px;object-fit:cover;border-radius:.3rem}
.card .body{flex:1;min-width:10rem}
.list{display:flex;flex-direction:column;gap:.5rem}
.row{display:flex;gap:.5rem 1rem;flex-wrap:wrap;align-items:center}
.row .t{flex:1;min-width:12rem;font-weight:600}
.meta{color:var(--muted);font-size:.85rem}
.pill{font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:0 .5rem;color:var(--muted)}
.actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem}
button,select,input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.4rem;padding:.3rem .6rem}
button{cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled,button[aria-disabled=true]{opacity:.5;cursor:not-allowed}
form.inline,form.filters{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
form.rate{display:flex;flex-direction:column;gap:.4rem;width:100%}
.empty{color:var(--muted);font-style:italic}
.bad{color:var(--bad)}
#toast{position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:.6rem 1rem;border-radius:.5rem;max-width:90vw;z-index:10}
[hidden]{display:none!important}
`;

export function formatSync(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function Layout(props: { active: string; status: StatusStrip; title?: string; children?: Child }) {
  const { active, status } = props;
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title ?? "Media Tracker"}</title>
          <style>{raw(CSS)}</style>
        </head>
        <body>
          <header>
            <div class="strip">
              <strong>Media Tracker</strong>
              <span>Last inbox sync: {formatSync(status.lastSync)}</span>
              <span>Pending enrichment: {status.pending}</span>
              <span class={status.failed > 0 ? "bad" : ""}>Failed: {status.failed}</span>
              <span class="grow" />
              <button type="button" class="primary" data-action="sweep">Sweep Inbox Now</button>
              <button type="button" data-action="backup" aria-disabled="true" title="Coming soon">
                Backup to Google Sheets
              </button>
            </div>
            <nav aria-label="Sections">
              {TABS.map((t) => (
                <a href={t.href} aria-current={t.key === active ? "page" : undefined}>
                  {t.label}
                </a>
              ))}
            </nav>
          </header>
          <main>{props.children}</main>
          <div id="toast" role="status" hidden />
          <script>{raw(CLIENT_SCRIPT)}</script>
        </body>
      </html>
    </>
  );
}
