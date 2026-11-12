import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, TIERS, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { isMediaType } from "../api/validate";
import { Layout, loadStatusStrip } from "./layout";
import { createLibraryRoutes } from "./library";

const LIMIT = 100;

export const TIME_BUCKETS = [
  { value: "le30", label: "30 min or less" },
  { value: "le120", label: "2 hours or less" },
  { value: "le600", label: "10 hours or less" },
  { value: "gt600", label: "Over 10 hours or unknown" },
] as const;

function bucketCond(v: string | undefined): SQL | undefined {
  const m = mediaItems.timeCommitmentMinutes;
  switch (v) {
    case "le30":
      return lte(m, 30);
    case "le120":
      return lte(m, 120);
    case "le600":
      return lte(m, 600);
    case "gt600":
      return or(isNull(m), gt(m, 600));
    default:
      return undefined;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function daysAgo(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

function safeImg(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function StatusButton(props: { id: string; status: string; label: string; primary?: boolean }) {
  return (
    <button type="button" class={props.primary ? "primary" : ""} data-action="status" data-id={props.id} data-status={props.status}>
      {props.label}
    </button>
  );
}

const RATINGS = Array.from({ length: 9 }, (_, i) => 1 + i * 0.5);

function RateForm(props: { id: string; action: "complete" | "rate"; label: string; hidden?: boolean }) {
  return (
    <form class="rate" id={`rate-${props.id}`} data-action={props.action} data-id={props.id} hidden={props.hidden}>
      <label>
        Rating{" "}
        <select name="rating" required>
          {RATINGS.map((r) => (
            <option value={String(r)} selected={r === 3}>
              {r.toFixed(1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tier{" "}
        <select name="tier">
          <option value="">(none)</option>
          {TIERS.map((t) => (
            <option value={t}>{t}</option>
          ))}
        </select>
      </label>
      <textarea name="review_text" rows={2} maxlength={10000} placeholder="Short note" />
      <div>
        <button type="submit" class="primary">
          {props.label}
        </button>
      </div>
    </form>
  );
}

function ActiveCard(props: { item: MediaItem }) {
  const i = props.item;
  const img = safeImg(i.posterImageUrl);
  return (
    <div class="card">
      {img ? <img src={img} alt="" loading="lazy" width="56" height="84" /> : null}
      <div class="body">
        <strong>{i.title}</strong>
        <div class="meta">
          <span class="pill">{i.mediaType}</span> {i.creator}
        </div>
        <div class="meta">{i.timeCommitmentDisplay || "Time unknown"}</div>
        <div class="actions">
          <StatusButton id={i.id} status="Paused" label="Pause" />
          <button type="button" class="primary" data-action="toggle-rate" data-id={i.id}>
            Complete &amp; Rate
          </button>
        </div>
      </div>
      <RateForm id={i.id} action="complete" label="Complete" hidden />
    </div>
  );
}

function UpNextRow(props: { item: MediaItem }) {
  const i = props.item;
  return (
    <div class="row">
      <div class="t">{i.title}</div>
      <span class="pill">{i.mediaType}</span>
      <span class="meta">{i.releaseAccessDisplay}</span>
      <span class="meta">{i.criticScoreDisplay}</span>
      <span class="meta">{i.timeCommitmentDisplay}</span>
      <span class="meta">Score {i.priorityScore.toFixed(1)}</span>
      <div class="actions">
        <StatusButton id={i.id} status="Active" label="Start" primary />
        <StatusButton id={i.id} status="Backlog" label="Move to Backlog" />
      </div>
    </div>
  );
}

export function createUiRoutes(options: { now?: () => Date } = {}) {
  const nowFn = options.now ?? (() => new Date());
  const ui = new Hono<{ Bindings: { DB: D1Database } }>();

  ui.get("/", async (c) => {
    const now = nowFn();
    const db = drizzle(c.env.DB);
    const q = c.req.query();
    const type = isMediaType(q.type) ? q.type : "";
    const streaming = (q.streaming ?? "").trim().slice(0, 100);
    const time = TIME_BUCKETS.some((b) => b.value === q.time) ? (q.time as string) : "";

    const upConds: (SQL | undefined)[] = [eq(mediaItems.status, "Up Next")];
    if (type) upConds.push(eq(mediaItems.mediaType, type));
    if (streaming) {
      upConds.push(sql`${mediaItems.streamingProvidersJson} LIKE ${"%" + escapeLike(streaming) + "%"} ESCAPE '\\'`);
    }
    upConds.push(bucketCond(time));

    const [status, active, paused, upNext, pending] = await Promise.all([
      loadStatusStrip(c.env.DB, now),
      db.select().from(mediaItems).where(eq(mediaItems.status, "Active")).orderBy(desc(mediaItems.lastStatusChangeAt), asc(mediaItems.id)).limit(LIMIT),
      db.select().from(mediaItems).where(eq(mediaItems.status, "Paused")).orderBy(desc(mediaItems.lastStatusChangeAt), asc(mediaItems.id)).limit(LIMIT),
      db.select().from(mediaItems).where(and(...upConds)).orderBy(desc(mediaItems.priorityScore), asc(mediaItems.id)).limit(LIMIT),
      db
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.status, "Completed"), eq(mediaItems.reviewDone, false)))
        .orderBy(desc(mediaItems.completedAt), asc(mediaItems.id))
        .limit(LIMIT),
    ]);

    const filtered = Boolean(type || streaming || time);
    return c.html(
      <Layout active="now" status={status} title="Now & Next">
        <h1>Now &amp; Next</h1>

        <h2>Active</h2>
        {active.length === 0 ? (
          <p class="empty">Nothing active. Start something from Up Next.</p>
        ) : (
          <div class="cards">
            {active.map((i) => (
              <ActiveCard item={i} />
            ))}
          </div>
        )}

        <h2>Paused</h2>
        {paused.length === 0 ? (
          <p class="empty">Nothing paused.</p>
        ) : (
          <div class="list">
            {paused.map((i) => (
              <div class="row">
                <div class="t">{i.title}</div>
                <span class="pill">{i.mediaType}</span>
                <span class="meta">paused {daysAgo(i.lastStatusChangeAt, now)} days ago</span>
                <div class="actions">
                  <StatusButton id={i.id} status="Active" label="Resume" primary />
                </div>
              </div>
            ))}
          </div>
        )}

        <h2>Up Next</h2>
        <form class="filters" method="get" action="/">
          <select name="type" aria-label="Type">
            <option value="">All types</option>
            {MEDIA_TYPES.map((t) => (
              <option value={t} selected={t === type}>
                {t}
              </option>
            ))}
          </select>
          <input type="text" name="streaming" value={streaming} placeholder="Streaming service" aria-label="Streaming service" maxlength={100} />
          <select name="time" aria-label="Time commitment">
            <option value="">Any length</option>
            {TIME_BUCKETS.map((b) => (
              <option value={b.value} selected={b.value === time}>
                {b.label}
              </option>
            ))}
          </select>
          <button type="submit">Filter</button>
          {filtered ? <a href="/">Clear</a> : null}
        </form>
        {upNext.length === 0 ? (
          <p class="empty">{filtered ? "No Up Next items match these filters." : "Up Next is empty."}</p>
        ) : (
          <div class="list" style="margin-top:.6rem">
            {upNext.map((i) => (
              <UpNextRow item={i} />
            ))}
          </div>
        )}

        <h2>Pending Review</h2>
        {pending.length === 0 ? (
          <p class="empty">No completed items waiting for a review.</p>
        ) : (
          <div class="list">
            {pending.map((i) => (
              <div class="row">
                <div class="t">{i.title}</div>
                <span class="pill">{i.mediaType}</span>
                <RateForm id={i.id} action="rate" label="Save review" />
              </div>
            ))}
          </div>
        )}

        <h2>Backlog quick add</h2>
        <form class="inline" data-action="add">
          <input type="text" name="title" required maxlength={300} placeholder="Title" aria-label="Title" />
          <select name="media_type" aria-label="Type">
            {MEDIA_TYPES.map((t) => (
              <option value={t}>{t}</option>
            ))}
          </select>
          <button type="submit" class="primary">
            Add to Backlog
          </button>
        </form>
      </Layout>,
    );
  });

  ui.route("/", createLibraryRoutes(options));
  return ui;
}
