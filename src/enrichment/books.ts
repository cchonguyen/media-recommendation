import type { EnrichContext, EnrichOutcome, Enricher } from "./types";

const API = "https://www.googleapis.com/books/v1/volumes";

interface Volume {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    pageCount?: number;
    categories?: string[];
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const yearOf = (v: Volume) => Number(v.volumeInfo?.publishedDate?.slice(0, 4)) || null;

/** Exact title first, then the year hint, else the API's own relevance order. */
export function pickVolume(items: Volume[], title: string, yearHint: number | null): Volume | undefined {
  if (items.length === 0) return undefined;
  const exact = items.filter((v) => norm(v.volumeInfo?.title) === norm(title));
  let pool = exact.length > 0 ? exact : items;
  if (yearHint != null) {
    const byYear = pool.filter((v) => yearOf(v) === yearHint);
    if (byYear.length > 0) pool = byYear;
  }
  return pool[0];
}

export function amazonLink(isbn13: string | null, title: string): string {
  return `https://www.amazon.com/s?k=${isbn13 || encodeURIComponent(title)}`;
}

export const booksEnricher: Enricher = {
  subrequestsNeeded: () => 1,
  hasCredentials: () => true,
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const url = new URL(API);
    url.searchParams.set("q", `intitle:${ctx.row.title}`);
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("printType", "books");
    if (ctx.env.GOOGLE_BOOKS_API_KEY) url.searchParams.set("key", ctx.env.GOOGLE_BOOKS_API_KEY);
    ctx.budget?.take();
    const res = await (ctx.fetchImpl ?? fetch)(url.href);
    // The message omits the URL: it can carry the key.
    if (!res.ok) throw new Error(`Google Books returned HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Volume[] };
    const v = pickVolume(body.items ?? [], ctx.row.title, ctx.row.yearHint);
    const info = v?.volumeInfo;
    if (!v || !info) return { kind: "not-found" };

    const published = info.publishedDate ?? "";
    const releaseYear = Number(published.slice(0, 4)) || null;
    const fullDate = /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : null;
    const today = ctx.now.toISOString().slice(0, 10);
    const upcoming = fullDate ? fullDate > today : releaseYear != null && releaseYear > ctx.now.getUTCFullYear();
    const isbn13 = info.industryIdentifiers?.find((i) => i.type === "ISBN_13")?.identifier ?? null;
    const pages = info.pageCount && info.pageCount > 0 ? info.pageCount : null;
    const thumb = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? "";
    return {
      kind: "ok",
      fields: {
        isbn13,
        creator: (info.authors ?? []).join(", "),
        releaseYear,
        releaseDate: fullDate,
        releaseState: upcoming ? "Upcoming" : "Published",
        genresJson: JSON.stringify(info.categories ?? []),
        timeCommitmentDisplay: pages ? `${pages} pages` : "",
        timeCommitmentMinutes: pages ? pages * 2 : null,
        posterImageUrl: thumb.replace(/^http:\/\//, "https://"),
        amazonLink: amazonLink(isbn13, ctx.row.title),
      },
    };
  },
};
