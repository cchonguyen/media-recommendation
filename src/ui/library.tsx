import { Hono } from "hono";
import { and, asc, desc, eq, isNotNull, isNull, like, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, STATUSES, TIERS, mediaItems } from "../db/schema";
import type { MediaItem } from "../db/schema";
import { isMediaType, isStatus, isTier } from "../api/validate";
import { Layout, loadStatusStrip } from "./layout";
import { Icon } from "./icons";
import { MEDIA_TYPE_ICON, Missing, STATUS_META, SelectBox, StarRating } from "./controls";

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

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type TriState = "" | "yes" | "no";
const parseTri = (v: string | undefined): TriState => (v === "yes" || v === "no" ? v : "");

interface Params {
  page: number;
  sort: SortKey;
  dir: "asc" | "desc";
  status: string;
  q: string;
  type: string;
  year: string;
  tier: string;
  rated: TriState;
  has_notes: TriState;
  has_review: TriState;
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
    tier: isTier(q.tier) ? q.tier : "",
    rated: parseTri(q.rated),
    has_notes: !archive ? parseTri(q.has_notes) : "",
    has_review: archive ? parseTri(q.has_review) : "",
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
    tier: p.tier,
    rated: p.rated,
    has_notes: p.has_notes,
    has_review: p.has_review,
    page: String(p.page),
  };
  const o = over as Record<string, string | number>;
  if ("year" in o) m.consumed_year = String(o.year);
  for (const k of ["sort", "dir", "status", "q", "type", "tier", "rated", "has_notes", "has_review", "page"]) if (k in o) m[k] = String(o[k]);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(m)) if (v !== "" && !(k === "page" && v === "1")) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

function FilterToggle(props: { name: string; state: TriState; anyLabel: string; yesLabel: string; noLabel: string }) {
  const { name, state, anyLabel, yesLabel, noLabel } = props;
  const label = state === "yes" ? yesLabel : state === "no" ? noLabel : anyLabel;
  return (
    <>
      <input type="hidden" name={name} value={state} />
      <button
        type="button"
        class="ui-filter-toggle"
        data-action="filter-toggle"
        data-filter-name={name}
        data-state={state || undefined}
        aria-pressed={state === "yes" ? "true" : state === "no" ? "mixed" : "false"}
      >
        {state === "yes" ? <Icon name="check" /> : state === "no" ? <Icon name="minus" /> : null}
        {label}
      </button>
    </>
  );
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
    <div class="rating-cell ui-control-pair" data-id={i.id}>
      <StarRating itemId={i.id} value={i.myRating} label={`Rating for ${i.title}`} mode="inline" />
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
  const opts = STATUSES.filter((s) => s !== "Archived" || i.status === "Archived");
  const meta = STATUS_META[i.status] ?? { icon: "clock" as const, tone: "neutral" as const };
  return (
    <div class={`app-status-select app-status-select--${meta.tone}`}>
      <span class="app-status-select__face" aria-hidden="true">
        <Icon name={meta.icon} size={16} />
        <span>{i.status}</span>
        <Icon name="chevron-down" size={14} />
      </span>
      <select class="ui-select app-status-select__native" data-action="set-status" data-id={i.id} aria-label={`Status for ${i.title}`}>
        {opts.map((s) => (
          <option value={s} selected={s === i.status}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}

function TypeSelect(props: { i: MediaItem }) {
  const { i } = props;
  const icon = MEDIA_TYPE_ICON[i.mediaType] ?? "film";
  return (
    <div class="app-icon-select" data-tooltip={i.mediaType}>
      <span class="app-icon-select__face" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <select
        class="ui-select app-icon-select__native"
        data-action="set-type"
        data-id={i.id}
        aria-label={`Type for ${i.title}: ${i.mediaType}`}
        title={i.mediaType}
      >
        {MEDIA_TYPES.map((t) => (
          <option value={t} selected={t === i.mediaType}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function TitleInput(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <span class="app-title-wrap" data-tooltip={i.title}>
      <input class="ui-input app-title-input" type="text" data-action="title" data-id={i.id} value={i.title} maxlength={300} aria-label={`Title of ${i.title}`} />
    </span>
  );
}

function LibraryRow(props: { i: MediaItem }) {
  const { i } = props;
  return (
    <tr>
      <td class="app-col-type">
        <TypeSelect i={i} />
      </td>
      <td>
        <TitleInput i={i} />
      </td>
      <td>
        <StatusSelect i={i} />
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
      <td class="app-col-sticky-right">
        <button type="button" class="ui-icon-btn" data-action="archive" data-id={i.id} aria-label={`Archive ${i.title}`} title={`Archive ${i.title}`}>
          <Icon name="archive" />
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
      <td class="app-col-type">
        <TypeSelect i={i} />
      </td>
      <td>
        <TitleInput i={i} />
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
    if (p.tier) conds.push(eq(mediaItems.personalTier, p.tier as (typeof TIERS)[number]));
    if (p.rated === "yes") conds.push(isNotNull(mediaItems.myRating));
    if (p.rated === "no") conds.push(isNull(mediaItems.myRating));
    if (p.has_notes === "yes") conds.push(ne(mediaItems.personalNotes, ""));
    if (p.has_notes === "no") conds.push(eq(mediaItems.personalNotes, ""));
    if (p.has_review === "yes") conds.push(ne(mediaItems.reviewText, ""));
    if (p.has_review === "no") conds.push(eq(mediaItems.reviewText, ""));
    if (p.q) conds.push(sql`${mediaItems.title} LIKE ${"%" + escapeLike(p.q) + "%"} ESCAPE '\\'`);
    const where = and(...conds);

    const db = drizzle(c.env.DB as D1Database);
    const [status, countRows, yearRows] = await Promise.all([
      loadStatusStrip(c.env.DB, nowFn()),
      db.select({ n: sql<number>`count(*)` }).from(mediaItems).where(where),
      archive
        ? db
            .selectDistinct({ y: mediaItems.consumedYear })
            .from(mediaItems)
            .where(and(eq(mediaItems.status, "Completed"), isNotNull(mediaItems.consumedYear)))
            .orderBy(desc(mediaItems.consumedYear))
        : Promise.resolve([]),
    ]);
    const yearSet = new Set(yearRows.map((r) => r.y).filter((y): y is number => y !== null));
    if (p.year) yearSet.add(Number(p.year));
    const years = Array.from(yearSet).sort((a, b) => b - a);

    const total = Number(countRows[0]?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    p.page = Math.min(p.page, pages);
    const col = SORTS[p.sort];
    const rows = await db
      .select()
      .from(mediaItems)
      .where(where)
      .orderBy(p.dir === "asc" ? asc(col) : desc(col), asc(mediaItems.id))
      .limit(PAGE_SIZE)
      .offset((p.page - 1) * PAGE_SIZE);

    const heading = archive ? "Completed Archive" : TYPE_ROUTES[slug as keyof typeof TYPE_ROUTES].label;
    const activeFilters: { key: keyof Params; label: string }[] = [];
    if (p.status) activeFilters.push({ key: "status", label: p.status });
    if (p.type) activeFilters.push({ key: "type", label: p.type });
    if (p.year) activeFilters.push({ key: "year", label: p.year });
    if (p.tier) activeFilters.push({ key: "tier", label: `Tier ${p.tier}` });
    if (p.rated === "yes") activeFilters.push({ key: "rated", label: "Has rating" });
    if (p.rated === "no") activeFilters.push({ key: "rated", label: "No rating" });
    if (p.has_notes === "yes") activeFilters.push({ key: "has_notes", label: "Has notes" });
    if (p.has_notes === "no") activeFilters.push({ key: "has_notes", label: "No notes" });
    if (p.has_review === "yes") activeFilters.push({ key: "has_review", label: "Has review" });
    if (p.has_review === "no") activeFilters.push({ key: "has_review", label: "No review" });
    const activeCount = activeFilters.length;
    const filtered = Boolean(p.q || activeCount > 0);
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
        <form class="app-stack" method="get" action={base} data-filter-form="">
          <div class="ui-filter-bar">
            <input class="ui-input" id="q" type="text" name="q" value={p.q} placeholder="Search title" aria-label="Search title" maxlength={100} />
            <button
              type="button"
              class={activeCount > 0 ? "ui-btn ui-filter-trigger ui-filter-trigger--active" : "ui-btn ui-filter-trigger"}
              data-action="toggle-filters"
              aria-expanded={activeCount > 0 ? "true" : "false"}
              aria-controls="filter-panel"
            >
              <Icon name="sliders-horizontal" />
              {activeCount > 0 ? `Filters (${activeCount})` : "Filters"}
            </button>
            {activeFilters.map((f) => (
              <a href={href(base, p, { [f.key]: "", page: 1 })} class="ui-pill ui-pill--active app-filter-chip" aria-label={`Remove ${f.label} filter`}>
                <Icon name="check" />
                {f.label}
                <Icon name="x" />
              </a>
            ))}
            <button type="submit" class="ui-btn">
              Search
            </button>
            {filtered ? (
              <a class="ui-btn ui-btn--ghost" href={base}>
                Clear
              </a>
            ) : null}
          </div>
          <div class="ui-filter-panel" id="filter-panel" hidden={activeCount === 0}>
            <div class="ui-filter-group">
              {archive ? (
                <>
                  <select
                    class={p.type ? "ui-filter-select ui-filter-select--active" : "ui-filter-select"}
                    name="type"
                    aria-label="Filter by type"
                    data-active={p.type ? "true" : undefined}
                    data-filter-auto=""
                  >
                    <option value="">Type</option>
                    {MEDIA_TYPES.map((t) => (
                      <option value={t} selected={t === p.type}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    class={p.year ? "ui-filter-select ui-filter-select--active" : "ui-filter-select"}
                    name="consumed_year"
                    aria-label="Filter by consumed year"
                    data-active={p.year ? "true" : undefined}
                    data-filter-auto=""
                  >
                    <option value="">Year</option>
                    {years.map((y) => (
                      <option value={String(y)} selected={String(y) === p.year}>
                        {y}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <select
                  class={p.status ? "ui-filter-select ui-filter-select--active" : "ui-filter-select"}
                  name="status"
                  aria-label="Filter by status"
                  data-active={p.status ? "true" : undefined}
                  data-filter-auto=""
                >
                  <option value="">Status</option>
                  {STATUSES.map((s) => (
                    <option value={s} selected={s === p.status}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              <select
                class={p.tier ? "ui-filter-select ui-filter-select--active" : "ui-filter-select"}
                name="tier"
                aria-label="Filter by tier"
                data-active={p.tier ? "true" : undefined}
                data-filter-auto=""
              >
                <option value="">Tier</option>
                {TIERS.map((t) => (
                  <option value={t} selected={t === p.tier}>
                    {`Tier ${t}`}
                  </option>
                ))}
              </select>
            </div>
            <div class="ui-filter-group">
              <FilterToggle name="rated" state={p.rated} anyLabel="Rating" yesLabel="Has rating" noLabel="No rating" />
              {archive ? (
                <FilterToggle name="has_review" state={p.has_review} anyLabel="Review" yesLabel="Has review" noLabel="No review" />
              ) : (
                <FilterToggle name="has_notes" state={p.has_notes} anyLabel="Notes" yesLabel="Has notes" noLabel="No notes" />
              )}
            </div>
          </div>
          <input type="hidden" name="sort" value={p.sort} />
          <input type="hidden" name="dir" value={p.dir} />
        </form>
        <p class="ui-help">Editing a title to the form &quot;Title (2021)&quot; sets the year hint and re-runs enrichment for that item.</p>
        {rows.length === 0 ? (
          <p class="app-empty ui-missing">{filtered ? "No items match these filters." : "Nothing here yet."}</p>
        ) : (
          <div class="table-scroll ui-card">
            <table class="app-table ui-table">
              <caption>
                {heading} table
              </caption>
              <thead>
                {archive ? (
                  <tr>
                    <th class="app-col-type">Type</th>
                    {th("title", "Title")}
                    {th("consumed_year", "Consumed")}
                    {th("completed_at", "Completed")}
                    {th("my_rating", "Rating / Tier")}
                    <th>Review</th>
                  </tr>
                ) : (
                  <tr>
                    <th class="app-col-type">Type</th>
                    {th("title", "Title")}
                    {th("status", "Status")}
                    {th("release_year", "Year")}
                    <th>Creator</th>
                    {th("my_rating", "Rating / Tier")}
                    <th>Critics</th>
                    <th>Time</th>
                    <th>Access</th>
                    <th>Notes</th>
                    <th class="app-col-sticky-right"><span class="sr-only">Actions</span></th>
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
