import { Hono } from "hono";
import { and, asc, desc, eq, like, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, STATUSES, TIERS, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { isMediaType, isStatus } from "../api/validate";
import { Layout, loadStatusStrip } from "./layout";
import { Icon } from "./icons";
import { Field, Missing, SelectBox } from "./controls";

export const PAGE_SIZE = 50;

const TYPE_ROUTES = {
  movies: { type: "Movie", label: "Movies" },
  tv: { type: "TV", label: "TV" },
  books: { type: "Book", label: "Books" },
  games: { type: "Game", label: "Games" },
  podcasts: { type: "Podcast", label: "Podcasts" },
  "one-offs": { type: "One-Off", label: "One-Offs" },
} as const;

const SORTS = {
  title: mediaItems.title,
  status: mediaItems.status,
  my_rating: mediaItems.myRating,
  release_year: mediaItems.releaseYear,
  consumed_year: mediaItems.consumedYear,
  completed_at: mediaItems.completedAt,
  priority_score: mediaItems.priorityScore,
  created_at: mediaItems.createdAt,
} as const;
type SortKey = keyof typeof SORTS;
const isSort = (v: unknown): v is SortKey => typeof v === "string" && Object.prototype.hasOwnProperty.call(SORTS, v);

const RATINGS = Array.from({ length: 9 }, (_, i) => 1 + i * 0.5);

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Params {
  page: number;
  sort: SortKey;
  dir: "asc" | "desc";
  status: string;
  q: string;
  type: string;
  year: string;
}

function parseParams(q: Record<string, string>, archive: boolean): Params {
  const page = Number.parseInt(q.page ?? "", 10);
  const yr = (q.consumed_year ?? "").trim();
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 1_000_000) : 1,
    sort: isSort(q.sort) ? q.sort : archive ? "completed_at" : "priority_score",
    dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : archive || !isSort(q.sort) || q.sort === "priority_score" ? "desc" : "asc",
    status: !archive && isStatus(q.status) ? q.status : "",
    q: (q.q ?? "").trim().slice(0, 100),
    type: archive && isMediaType(q.type) ? q.type : "",
    year: archive && /^\d{4}$/.test(yr) ? yr : "",
  };
}

function href(base: string, p: Params, over: Partial<Record<keyof Params, string | number>>): string {
  const m: Record<string, string> = {
    sort: p.sort,
    dir: p.dir,
    status: p.status,
    q: p.q,
    type: p.type,
    consumed_year: p.year,
    page: String(p.page),
  };
  const o = over as Record<string, string | number>;
  if ("year" in o) m.consumed_year = String(o.year);
  for (const k of ["sort", "dir", "status", "q", "type", "page"]) if (k in o) m[k] = String(o[k]);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(m)) if (v !== "" && !(k === "page" && v === "1")) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

function SortTh(props: { base: string; p: Params; col: SortKey; label: string }) {
  const { p, col } = props;
  const next = p.sort === col && p.dir === "asc" ? "desc" : "asc";
  const sorted = p.sort === col;
  return (
    <th aria-sort={sorted ? (p.dir === "asc" ? "ascending" : "descending") : undefined}>
      <a href={href(props.base, p, { sort: col, dir: next, page: 1 })}>
        {props.label}
        {sorted ? <Icon name={p.dir === "asc" ? "arrow-up" : "arrow-down"} /> : null}
      </a>
    </th>
  );
}

function RatingCell(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <div class="rating-cell app-actions" data-id={i.id}>
      <SelectBox label={`Rating for ${i.title}`} attrs={{ "data-action": "rating", "data-id": i.id }}>
        <option value="" selected={i.myRating === null}>
          -
        </option>
        {RATINGS.map((r) => (
          <option value={String(r)} selected={i.myRating === r}>
            {r.toFixed(1)}
          </option>
        ))}
      </SelectBox>
      <SelectBox label={`Tier for ${i.title}`} attrs={{ "data-action": "tier", "data-id": i.id }}>
        <option value="" selected={i.personalTier === null}>
          -
        </option>
        {TIERS.map((t) => (
          <option value={t} selected={i.personalTier === t}>
            {t}
          </option>
        ))}
      </SelectBox>
    </div>
  );
}

function StatusSelect(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <SelectBox label={`Status for ${i.title}`} attrs={{ "data-action": "set-status", "data-id": i.id }}>
      {STATUSES.filter((s) => s !== "Archived" || i.status === "Archived").map((s) => (
        <option value={s} selected={s === i.status}>
          {s}
        </option>
      ))}
    </SelectBox>
  );
}

function TypeSelect(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <SelectBox label={`Type for ${i.title}`} attrs={{ "data-action": "set-type", "data-id": i.id }}>
      {MEDIA_TYPES.map((t) => (
        <option value={t} selected={t === i.mediaType}>
          {t}
        </option>
      ))}
    </SelectBox>
  );
}

function TitleInput(props: { i: MediaItem }) {
  const { i } = props;
  return <input class="ui-input" type="text" data-action="title" data-id={i.id} value={i.title} maxlength={300} aria-label={`Title of ${i.title}`} />;
}

function LibraryRow(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <tr>
      <td>
        <TitleInput i={i} />
      </td>
      <td>
        <StatusSelect i={i} />
      </td>
      <td>
        <TypeSelect i={i} />
      </td>
      <td>{i.releaseYear ?? <Missing />}</td>
      <td>{i.creator || <Missing />}</td>
      <td>
        <RatingCell i={i} />
      </td>
      <td>{i.criticScoreDisplay || <Missing />}</td>
      <td>{i.timeCommitmentDisplay || <Missing />}</td>
      <td>{i.releaseAccessDisplay}</td>
      <td>
        <input class="ui-input" type="text" data-action="notes" data-id={i.id} value={i.personalNotes} maxlength={10000} aria-label={`Notes for ${i.title}`} />
      </td>
      <td>
        <button type="button" class="ui-btn ui-btn--ghost" data-action="archive" data-id={i.id} aria-label={`Archive ${i.title}`}>
          Archive
        </button>
      </td>
    </tr>
  );
}

function ArchiveRow(props: { i: MediaItem }) {
  const { i } = props;
  const review = i.reviewText.length > 80 ? i.reviewText.slice(0, 80) + "…" : i.reviewText;
  return (
    <tr>
      <td>
        <TitleInput i={i} />
      </td>
      <td>
        <TypeSelect i={i} />
      </td>
      <td>{i.consumedYear ?? <Missing />}</td>
      <td>{i.completedAt ? i.completedAt.slice(0, 10) : <Missing text="No date yet" />}</td>
      <td>
        <RatingCell i={i} />
      </td>
      <td title={i.reviewText}>{review}</td>
    </tr>
  );
}

function Pager(props: { base: string; p: Params; total: number; pages: number; shown: number }) {
  const { base, p, total, pages, shown } = props;
  return (
    <div class="app-pager">
      <span class="ui-data">
        {total === 0 ? "0 rows" : `Showing ${shown} of ${total} rows`} (page {p.page} of {pages})
      </span>
      {p.page > 1 ? (
        <a class="ui-btn" rel="prev" href={href(base, p, { page: p.page - 1 })}>
          Previous
        </a>
      ) : null}
      {p.page < pages ? (
        <a class="ui-btn" rel="next" href={href(base, p, { page: p.page + 1 })}>
          Next
        </a>
      ) : null}
    </div>
  );
}

export function createLibraryRoutes(options: { now?: () => Date } = {}) {
  const nowFn = options.now ?? (() => new Date());
  const lib = new Hono<{ Bindings: { DB: D1Database } }>();

  async function render(c: any, slug: string, archive: boolean, forcedType: string | null) {
    const q = c.req.query() as Record<string, string>;
    const p = parseParams(q, archive);
    const base = `/library/${slug}`;
    const conds: (SQL | undefined)[] = [];
    if (archive) conds.push(eq(mediaItems.status, "Completed"));
    else {
      if (forcedType) conds.push(eq(mediaItems.mediaType, forcedType as (typeof MEDIA_TYPES)[number]));
      conds.push(p.status ? eq(mediaItems.status, p.status as (typeof STATUSES)[number]) : ne(mediaItems.status, "Archived"));
    }
    if (p.type) conds.push(eq(mediaItems.mediaType, p.type as (typeof MEDIA_TYPES)[number]));
    if (p.year) conds.push(eq(mediaItems.consumedYear, Number(p.year)));
    if (p.q) conds.push(sql`${mediaItems.title} LIKE ${"%" + escapeLike(p.q) + "%"} ESCAPE '\\'`);
    const where = and(...conds);

    const [status, countRows] = await Promise.all([
      loadStatusStrip(c.env.DB, nowFn()),
      drizzle(c.env.DB as D1Database).select({ n: sql<number>`count(*)` }).from(mediaItems).where(where),
    ]);
    const total = Number(countRows[0]?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    p.page = Math.min(p.page, pages);
    const col = SORTS[p.sort];
    const rows = await drizzle(c.env.DB as D1Database)
      .select()
      .from(mediaItems)
      .where(where)
      .orderBy(p.dir === "asc" ? asc(col) : desc(col), asc(mediaItems.id))
      .limit(PAGE_SIZE)
      .offset((p.page - 1) * PAGE_SIZE);

    const heading = archive ? "Completed Archive" : TYPE_ROUTES[slug as keyof typeof TYPE_ROUTES].label;
    const filtered = Boolean(p.q || p.status || p.type || p.year);
    const th = (col: SortKey, label: string) => <SortTh base={base} p={p} col={col} label={label} />;
    return c.html(
      <Layout active={slug} status={status} title={heading} heading={heading}>
        {archive ? null : (
          <nav class="app-subnav" aria-label="Library sections">
            {Object.entries(TYPE_ROUTES).map(([k, r]) => {
              const current = k === slug;
              return (
                <a href={`/library/${k}`} class={current ? "ui-pill ui-pill--active" : "ui-pill"} aria-current={current ? "page" : undefined}>
                  {current ? <Icon name="check" /> : null}
                  {r.label}
                </a>
              );
            })}
          </nav>
        )}
        <form class="app-form" method="get" action={base}>
          <Field id="q" label="Search title">
            <input class="ui-input" id="q" type="text" name="q" value={p.q} placeholder="Search title" maxlength={100} />
          </Field>
          {archive ? (
            <>
              <Field id="f-type" label="Type">
                <SelectBox id="f-type" name="type">
                  <option value="">All types</option>
                  {MEDIA_TYPES.map((t) => (
                    <option value={t} selected={t === p.type}>
                      {t}
                    </option>
                  ))}
                </SelectBox>
              </Field>
              <Field id="f-year" label="Consumed year">
                <input class="ui-input" id="f-year" type="text" name="consumed_year" value={p.year} placeholder="Year" inputmode="numeric" maxlength={4} />
              </Field>
            </>
          ) : (
            <Field id="f-status" label="Status">
              <SelectBox id="f-status" name="status">
                <option value="">Active statuses</option>
                {STATUSES.map((s) => (
                  <option value={s} selected={s === p.status}>
                    {s}
                  </option>
                ))}
              </SelectBox>
            </Field>
          )}
          <input type="hidden" name="sort" value={p.sort} />
          <input type="hidden" name="dir" value={p.dir} />
          <button type="submit" class="ui-btn">
            Filter
          </button>
          {filtered ? (
            <a class="ui-btn ui-btn--ghost" href={base}>
              Clear
            </a>
          ) : null}
        </form>
        <p class="ui-help">Editing a title to the form &quot;Title (2021)&quot; sets the year hint and re-runs enrichment for that item.</p>
        {rows.length === 0 ? (
          <p class="app-empty ui-missing">{filtered ? "No items match these filters." : "Nothing here yet."}</p>
        ) : (
          <div class="table-scroll ui-card">
            <table class="app-table">
              <caption>
                {heading} table
              </caption>
              <thead>
                {archive ? (
                  <tr>
                    {th("title", "Title")}
                    <th>Type</th>
                    {th("consumed_year", "Consumed")}
                    {th("completed_at", "Completed")}
                    {th("my_rating", "Rating / Tier")}
                    <th>Review</th>
                  </tr>
                ) : (
                  <tr>
                    {th("title", "Title")}
                    {th("status", "Status")}
                    <th>Type</th>
                    {th("release_year", "Year")}
                    <th>Creator</th>
                    {th("my_rating", "Rating / Tier")}
                    <th>Critics</th>
                    <th>Time</th>
                    <th>Access</th>
                    <th>Notes</th>
<th>Actions</th>
                  </tr>
                )}
              </thead>
              <tbody>{rows.map((i) => (archive ? <ArchiveRow i={i} /> : <LibraryRow i={i} />))}</tbody>
            </table>
          </div>
        )}
        <Pager base={base} p={p} total={total} pages={pages} shown={rows.length} />
      </Layout>,
    );
  }

  lib.get("/library/completed", (c) => render(c, "completed", true, null));

  lib.get("/library/:type", async (c) => {
    const slug = c.req.param("type");
    if (!Object.prototype.hasOwnProperty.call(TYPE_ROUTES, slug)) {
      const status = await loadStatusStrip(c.env.DB, nowFn());
      return c.html(
        <Layout active="" status={status} title="Not found" heading="Not found">
          <p class="app-empty ui-missing">There is no library section called that. Use the tabs above.</p>
        </Layout>,
        404,
      );
    }
    return render(c, slug, false, TYPE_ROUTES[slug as keyof typeof TYPE_ROUTES].type);
  });

  return lib;
}
