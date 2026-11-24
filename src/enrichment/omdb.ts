import type { SubrequestBudget } from "../google/api";

export interface OmdbRatings {
  criticScore: number | null;
  criticScoreDisplay: string;
}

export interface OmdbArgs {
  imdbId: string;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
}

interface OmdbResponse {
  Response?: string;
  Error?: string;
  imdbRating?: string;
  Ratings?: { Source?: string; Value?: string }[];
}

const EMPTY: OmdbRatings = { criticScore: null, criticScoreDisplay: "" };

/** Pure mapping, exported for tests. */
export function parseOmdbRatings(body: OmdbResponse): OmdbRatings {
  let rt: number | null = null;
  let mc: number | null = null;
  for (const r of body.Ratings ?? []) {
    const v = r.Value ?? "";
    if (r.Source === "Rotten Tomatoes") {
      const m = /^(\d+(?:\.\d+)?)%$/.exec(v);
      if (m) rt = Number(m[1]);
    } else if (r.Source === "Metacritic") {
      const m = /^(\d+(?:\.\d+)?)\/100$/.exec(v);
      if (m) mc = Number(m[1]);
    }
  }
  const parts: string[] = [];
  const scores: number[] = [];
  if (rt !== null) {
    parts.push(`RT ${rt}%`);
    scores.push(rt);
  }
  if (mc !== null) {
    parts.push(`MC ${mc}`);
    scores.push(mc);
  }
  if (scores.length > 0) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { criticScore: Math.round(avg * 10) / 10, criticScoreDisplay: parts.join(" · ") };
  }
  const imdb = Number(body.imdbRating);
  if (body.imdbRating && Number.isFinite(imdb) && imdb > 0) {
    return { criticScore: Math.round(imdb * 100) / 10, criticScoreDisplay: `IMDb ${imdb}` };
  }
  return EMPTY;
}

/**
 * Never throws for missing key, HTTP errors or bad bodies: critic data is optional.
 * The caller's budget is still charged for a real request.
 */
export async function fetchOmdbRatings(args: OmdbArgs): Promise<OmdbRatings> {
  if (!args.apiKey || !args.imdbId) return EMPTY;
  try {
    args.budget?.take();
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("i", args.imdbId);
    url.searchParams.set("apikey", args.apiKey);
    const res = await (args.fetchImpl ?? fetch)(url.href);
    if (!res.ok) {
      console.warn(`OMDb returned HTTP ${res.status} for ${args.imdbId}`);
      return EMPTY;
    }
    const body = (await res.json()) as OmdbResponse;
    if (body.Response === "False") {
      console.warn(`OMDb rejected ${args.imdbId}: ${body.Error ?? "unknown error"}`);
      return EMPTY;
    }
    return parseOmdbRatings(body);
  } catch {
    return EMPTY;
  }
}
