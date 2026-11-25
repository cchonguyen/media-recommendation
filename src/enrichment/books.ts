import type { EnrichContext, EnrichOutcome, EnrichedFields, Enricher } from "./types";

const GOOGLE_API = "https://www.googleapis.com/books/v1/volumes";
const OPEN_LIBRARY_API = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_FIELDS = "title,author_name,first_publish_year,isbn,number_of_pages_median,subject,cover_i,ratings_average,ratings_count";

interface Volume {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    pageCount?: number;
    categories?: string[];
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    averageRating?: number;
    ratingsCount?: number;
  };
}

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  number_of_pages_median?: number;
  subject?: string[];
  cover_i?: number;
  ratings_average?: number;
  ratings_count?: number;
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

/** Exact title first, then the year hint, else the API's own relevance order. */
export function pickOpenLibraryDoc(docs: OpenLibraryDoc[], title: string, yearHint: number | null): OpenLibraryDoc | undefined {
  if (docs.length === 0) return undefined;
  const exact = docs.filter((d) => norm(d.title) === norm(title));
  let pool = exact.length > 0 ? exact : docs;
  if (yearHint != null) {
    const byYear = pool.filter((d) => d.first_publish_year === yearHint);
    if (byYear.length > 0) pool = byYear;
  }
  return pool[0];
}

export function amazonLink(isbn13: string | null, title: string): string {
  return `https://www.amazon.com/s?k=${isbn13 || encodeURIComponent(title)}`;
}

/**
 * Extracts a leading "by <Author>" prefix from personalNotes (up to `;` or end of line)
 * so it can serve as a search hint and be stripped once enrichment populates `creator`.
 */
export function extractAuthorHint(personalNotes: string | undefined): { author: string | null; remainingNotes: string } {
  const raw = (personalNotes ?? "").trim();
  if (!raw) return { author: null, remainingNotes: "" };
  const m = /^by\s+([^;\n]+?)(?:\s*\(ed\.?\))?(?:\s*;\s*(.*)|\s*$)/i.exec(raw);
  if (!m) return { author: null, remainingNotes: raw };
  const author = m[1]!.replace(/^dr\.\s+/i, "").trim();
  const remainingNotes = (m[2] ?? "").trim();
  return { author: author || null, remainingNotes };
}

function availabilityFields(upcoming: boolean, fullDate: string | null, releaseYear: number | null): Pick<EnrichedFields, "releaseState" | "releaseAccessDisplay" | "isAvailableNow"> {
  return {
    releaseState: upcoming ? "Upcoming" : "Published",
    releaseAccessDisplay: upcoming ? (fullDate ? `Releases ${fullDate}` : releaseYear ? `Releases ${releaseYear}` : "Upcoming") : "Published",
    isAvailableNow: !upcoming,
  };
}

export function mapBookRating(
  avg: number | undefined,
  count: number | undefined,
  source: "OL" | "GB",
): Pick<EnrichedFields, "criticScore" | "criticScoreDisplay"> {
  if (typeof avg === "number" && avg > 0 && (count ?? 0) >= 1) {
    return {
      criticScore: Math.round(avg * 200) / 10,
      criticScoreDisplay: `${source} ${avg.toFixed(1)}/5`,
    };
  }
  return { criticScore: null, criticScoreDisplay: "" };
}

function mapVolume(v: Volume, ctx: EnrichContext): EnrichOutcome {
  const info = v.volumeInfo;
  if (!info) return { kind: "not-found" };
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
      creator: [...new Set(info.authors ?? [])].join(", "),
      releaseYear,
      releaseDate: fullDate,
      ...availabilityFields(upcoming, fullDate, releaseYear),
      ...mapBookRating(info.averageRating, info.ratingsCount, "GB"),
      genresJson: JSON.stringify(info.categories ?? []),
      timeCommitmentDisplay: pages ? `${pages} pages` : "",
      timeCommitmentMinutes: pages ? pages * 2 : null,
      posterImageUrl: thumb.replace(/^http:\/\//, "https://"),
      amazonLink: amazonLink(isbn13, ctx.row.title),
    },
  };
}

async function queryOpenLibrary(title: string, author: string | null, ctx: EnrichContext): Promise<OpenLibraryDoc[]> {
  const url = new URL(OPEN_LIBRARY_API);
  url.searchParams.set("title", title);
  if (author) url.searchParams.set("author", author);
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", OPEN_LIBRARY_FIELDS);
  ctx.budget?.take();
  const res = await (ctx.fetchImpl ?? fetch)(url.href);
  if (!res.ok) throw new Error(`Open Library returned HTTP ${res.status}`);
  const body = (await res.json()) as { docs?: OpenLibraryDoc[] };
  return body.docs ?? [];
}

async function fetchOpenLibrary(ctx: EnrichContext, authorHint: string | null): Promise<EnrichOutcome> {
  let docs = await queryOpenLibrary(ctx.row.title, authorHint, ctx);
  let matchTitle = ctx.row.title;
  if (docs.length === 0) {
    const colonIdx = ctx.row.title.indexOf(":");
    if (colonIdx > 0) {
      matchTitle = ctx.row.title.slice(0, colonIdx).trim();
      docs = await queryOpenLibrary(matchTitle, authorHint, ctx);
    } else if (authorHint) {
      docs = await queryOpenLibrary(ctx.row.title, null, ctx);
    }
  }
  const doc = pickOpenLibraryDoc(docs, matchTitle, ctx.row.yearHint);
  if (!doc) return { kind: "not-found" };

  const releaseYear = doc.first_publish_year ?? null;
  const upcoming = releaseYear != null && releaseYear > ctx.now.getUTCFullYear();
  const isbns = doc.isbn ?? [];
  const isbn13 = isbns.find((i) => /^97[89]\d{10}$/.test(i)) ?? isbns.find((i) => /^\d{13}$/.test(i)) ?? null;
  const pages = doc.number_of_pages_median && doc.number_of_pages_median > 0 ? doc.number_of_pages_median : null;
  const subjects = (doc.subject ?? []).filter((s) => !s.includes(":") && !s.includes("=")).slice(0, 5);
  return {
    kind: "ok",
    fields: {
      isbn13,
      creator: [...new Set(doc.author_name ?? [])].join(", "),
      releaseYear,
      releaseDate: null,
      ...availabilityFields(upcoming, null, releaseYear),
      ...mapBookRating(doc.ratings_average, doc.ratings_count, "OL"),
      genresJson: JSON.stringify(subjects),
      timeCommitmentDisplay: pages ? `${pages} pages` : "",
      timeCommitmentMinutes: pages ? pages * 2 : null,
      posterImageUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : "",
      amazonLink: amazonLink(isbn13, ctx.row.title),
    },
  };
}

export const booksEnricher: Enricher = {
  subrequestsNeeded: (env) => (env.GOOGLE_BOOKS_API_KEY ? 3 : 2),
  hasCredentials: () => true,
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const authorHint = extractAuthorHint(ctx.row.personalNotes).author ?? (ctx.row.creator?.trim() || null);
    if (!ctx.env.GOOGLE_BOOKS_API_KEY) {
      return fetchOpenLibrary(ctx, authorHint);
    }
    const url = new URL(GOOGLE_API);
    const cleanTitle = ctx.row.title.replace(/"/g, " ").trim();
    const q = authorHint ? `intitle:"${cleanTitle}" inauthor:"${authorHint.replace(/"/g, " ").trim()}"` : `intitle:"${cleanTitle}"`;
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("printType", "books");
    url.searchParams.set("key", ctx.env.GOOGLE_BOOKS_API_KEY);
    ctx.budget?.take();
    const res = await (ctx.fetchImpl ?? fetch)(url.href);
    if (res.status === 429 || res.status >= 500) {
      return fetchOpenLibrary(ctx, authorHint);
    }
    // The message omits the URL: it can carry the key.
    if (!res.ok) throw new Error(`Google Books returned HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Volume[] };
    const v = pickVolume(body.items ?? [], ctx.row.title, ctx.row.yearHint);
    if (!v) return { kind: "not-found" };
    return mapVolume(v, ctx);
  },
};
