// Test-only helpers. Never imported by production code.
import type { RecordedCall } from "../google/test-helpers";
import { jsonResponse } from "../google/test-helpers";

export const NOW = new Date("2026-07-01T19:00:00Z");
export const TMDB_KEY = "tmdb-key-SECRET";
export const OMDB_KEY = "omdb-key-SECRET";

export type Route = (url: URL, call: RecordedCall) => Response | Promise<Response>;

/** Routes by "host/path" (no query). An unrouted request throws so a test fails loudly. */
export function routedFetch(routes: Record<string, Route | unknown>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call: RecordedCall = { url: url.href, method: init?.method ?? "GET", headers: {}, body: null };
    calls.push(call);
    const key = `${url.host}${url.pathname}`;
    const r = routes[key];
    if (r === undefined) throw new Error(`Unexpected fetch to ${key}`);
    if (r instanceof Response) return r.clone();
    if (typeof r === "function") return (r as Route)(url, call);
    return jsonResponse(r);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function movieSearch(...hits: object[]) {
  return { results: hits };
}

export function movieDetails(over: Record<string, unknown> = {}) {
  return {
    id: 438631,
    imdb_id: "tt1160419",
    title: "Dune",
    release_date: "2021-10-22",
    runtime: 155,
    poster_path: "/dune.jpg",
    genres: [{ name: "Science Fiction" }, { name: "Adventure" }],
    credits: { crew: [{ job: "Director", name: "Denis Villeneuve" }, { job: "Writer", name: "X" }] },
    release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2021-10-22T00:00:00.000Z" }] }] },
    "watch/providers": { results: { US: { flatrate: [{ provider_name: "Max" }] } } },
    ...over,
  };
}

export const omdbBody = {
  Response: "True",
  imdbRating: "8.0",
  Ratings: [
    { Source: "Internet Movie Database", Value: "8.0/10" },
    { Source: "Rotten Tomatoes", Value: "83%" },
    { Source: "Metacritic", Value: "74/100" },
  ],
};
