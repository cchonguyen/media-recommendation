import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, TIERS, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { isMediaType } from "../api/validate";
import { Layout, loadStatusStrip } from "./layout";
import { Field, IconMenu, MEDIA_TYPE_ICON, Missing, Pill, StarRating } from "./controls";
import { Icon } from "./icons";
import { createLibraryRoutes } from "./library";
import { createListsUiRoutes } from "./lists";

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

function StatusButton(props: { id: string; status: string; label: string; icon?: "play" | "pause"; ghost?: boolean }) {
  return (
    <button type="button" class={props.ghost ? "ui-btn ui-btn--ghost" : "ui-btn"} data-action="status" data-id={props.id} data-status={props.status}>
      {props.icon ? <Icon name={props.icon} /> : null}
      {props.label}
    </button>
  );
}

function RateForm(props: { id: string; action: "complete" | "rate"; label: string; hidden?: boolean }) {
  const base = `rate-${props.id}`;
  return (
    <form class="app-stack" id={base} data-action={props.action} data-id={props.id} hidden={props.hidden}>
      <Field id={`${base}-rating`} label="Rating">
        <StarRating id={`${base}-rating`} name="rating" value={3} label="Rating" mode="form" />
      </Field>
      <Field id={`${base}-tier`} label="Tier">
        <IconMenu
          id={`${base}-tier`}
          name="tier"
          value=""
          label="Tier"
          options={[
            { value: "", label: "None", icon: "award" },
            ...TIERS.map((t) => ({ value: t, label: t, icon: "award" as const })),
          ]}
        />
      </Field>
      <Field id={`${base}-note`} label="Short note">
        <textarea class="ui-textarea" id={`${base}-note`} name="review_text" rows={2} maxlength={10000} placeholder="Add a short note (optional)" />
      </Field>
      <div class="app-actions">
        <button type="submit" class="ui-btn">
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
    <article class="ui-card app-card-row">
      {img ? <img class="app-poster" src={img} alt="" loading="lazy" width="56" height="84" /> : null}
      <div class="app-card-body">
        <strong>{i.title}</strong>
        <div class="app-facts">
          <Pill icon={MEDIA_TYPE_ICON[i.mediaType]}>{i.mediaType}</Pill>
          {i.creator ? <span class="ui-muted">{i.creator}</span> : null}
        </div>
        {i.timeCommitmentDisplay ? <span class="ui-data">{i.timeCommitmentDisplay}</span> : <Missing text="Length not known yet" />}
        <div class="app-actions">
          <StatusButton id={i.id} status="Paused" label="Pause" icon="pause" />
          <button type="button" class="ui-btn" data-action="toggle-rate" data-id={i.id}>
            Complete &amp; Rate
          </button>
        </div>
      </div>
      <RateForm id={i.id} action="complete" label="Complete" hidden />
    </article>
  );
}

function UpNextRow(props: { item: MediaItem }) {
  const i = props.item;
  return (
    <div class="ui-card app-row">
      <div class="app-row__title">{i.title}</div>
      <Pill icon={MEDIA_TYPE_ICON[i.mediaType]}>{i.mediaType}</Pill>
      <span class="ui-data">{i.releaseAccessDisplay}</span>
      {i.criticScoreDisplay ? <span class="ui-data">{i.criticScoreDisplay}</span> : <Missing text="No score yet" />}
      {i.timeCommitmentDisplay ? <span class="ui-data">{i.timeCommitmentDisplay}</span> : <Missing text="Length not known yet" />}
      <span class="ui-data">{`Score ${i.priorityScore.toFixed(1)}`}</span>
      <div class="app-actions">
        <StatusButton id={i.id} status="Active" label="Start" icon="play" />
        <StatusButton id={i.id} status="Backlog" label="Move to Backlog" ghost />
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
      <Layout active="now" status={status} title="Now & Next" heading="Now & Next">
        <section class="app-section" aria-labelledby="h-active">
          <h2 class="ui-display app-h2" id="h-active">
            Active
          </h2>
          {active.length === 0 ? (
            <p class="app-empty ui-missing">Nothing active. Start something from Up Next.</p>
          ) : (
            <div class="app-cards">
              {active.map((i) => (
                <ActiveCard item={i} />
              ))}
            </div>
          )}
        </section>

        <section class="app-section" aria-labelledby="h-paused">
          <h2 class="ui-display app-h2" id="h-paused">
            Paused
          </h2>
          {paused.length === 0 ? (
            <p class="app-empty ui-missing">Nothing paused.</p>
          ) : (
            <div class="app-list">
              {paused.map((i) => (
                <div class="ui-card app-row">
                  <div class="app-row__title">{i.title}</div>
                  <Pill icon={MEDIA_TYPE_ICON[i.mediaType]}>{i.mediaType}</Pill>
                  <span class="ui-data ui-muted">{`paused ${daysAgo(i.lastStatusChangeAt, now)} days ago`}</span>
                  <div class="app-actions">
                    <StatusButton id={i.id} status="Active" label="Resume" icon="play" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section class="app-section" aria-labelledby="h-upnext">
          <h2 class="ui-display app-h2" id="h-upnext">
            Up Next
          </h2>
          <form class="app-form" method="get" action="/">
            <Field id="f-type" label="Type">
              <IconMenu
                id="f-type"
                name="type"
                value={type}
                label="Type"
                options={[
                  { value: "", label: "All types", icon: "layers" },
                  ...MEDIA_TYPES.map((t) => ({ value: t, label: t, icon: MEDIA_TYPE_ICON[t] ?? "film" })),
                ]}
              />
            </Field>
            <Field id="f-streaming" label="Streaming service">
              <input class="ui-input" id="f-streaming" type="text" name="streaming" value={streaming} maxlength={100} placeholder="Any service" />
            </Field>
            <Field id="f-time" label="Time commitment">
              <IconMenu
                id="f-time"
                name="time"
                value={time}
                label="Time commitment"
                options={[
                  { value: "", label: "Any length", icon: "clock" },
                  ...TIME_BUCKETS.map((b) => ({ value: b.value, label: b.label, icon: "clock" as const })),
                ]}
              />
            </Field>
            <button type="submit" class="ui-btn">
              Filter
            </button>
            {filtered ? (
              <a class="ui-btn ui-btn--ghost" href="/">
                Clear
              </a>
            ) : null}
          </form>
          {upNext.length === 0 ? (
            <p class="app-empty ui-missing">{filtered ? "No Up Next items match these filters." : "Up Next is empty."}</p>
          ) : (
            <div class="app-list">
              {upNext.map((i) => (
                <UpNextRow item={i} />
              ))}
            </div>
          )}
        </section>

        <section class="app-section" aria-labelledby="h-pending">
          <h2 class="ui-display app-h2" id="h-pending">
            Pending Review
          </h2>
          {pending.length === 0 ? (
            <p class="app-empty ui-missing">No completed items waiting for a review.</p>
          ) : (
            <div class="app-list">
              {pending.map((i) => (
                <div class="ui-card app-stack">
                  <div class="app-row">
                    <div class="app-row__title">{i.title}</div>
                    <Pill icon={MEDIA_TYPE_ICON[i.mediaType]}>{i.mediaType}</Pill>
                  </div>
                  <RateForm id={i.id} action="rate" label="Save review" />
                </div>
              ))}
            </div>
          )}
        </section>

        <section class="app-section" aria-labelledby="h-add">
          <h2 class="ui-display app-h2" id="h-add">
            Backlog quick add
          </h2>
          <form class="app-form" data-action="add">
            <Field id="add-title" label="Title">
              <input class="ui-input" id="add-title" type="text" name="title" required maxlength={300} placeholder="What do you want to track?" />
            </Field>
            <Field id="add-type" label="Type">
              <IconMenu
                id="add-type"
                name="media_type"
                value={MEDIA_TYPES[0]}
                label="Type"
                options={MEDIA_TYPES.map((t) => ({ value: t, label: t, icon: MEDIA_TYPE_ICON[t] ?? "film" }))}
              />
            </Field>
            <button type="submit" class="ui-btn ui-btn--primary">
              <Icon name="plus" />
              Add to Backlog
            </button>
          </form>
        </section>
      </Layout>,
    );
  });

  ui.route("/", createLibraryRoutes(options));
  ui.route("/", createListsUiRoutes(options));
  return ui;
}
