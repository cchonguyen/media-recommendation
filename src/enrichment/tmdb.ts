import type { SubrequestBudget } from "../google/api";
import type { EnrichedFields } from "./types";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const DAY_MS = 86_400_000;

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

export type TmdbResult = { kind: "ok"; fields: EnrichedFields } | { kind: "not-found" };

export interface TmdbArgs {
  mediaType: "Movie" | "TV";
  title: string;
  yearHint: number | null;
  apiKey: string;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now: Date;
}

interface SearchHit {
  id: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
}

interface ReleaseDateEntry {
  type: number;
  release_date: string;
}

interface Details {
  id: number;
  imdb_id?: string | null;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number;
  status?: string;
  in_production?: boolean;
  poster_path?: string | null;
  genres?: { name: string }[];
  created_by?: { name: string }[];
  vote_average?: number;
  vote_count?: number;
  external_ids?: { imdb_id?: string | null };
  credits?: { crew?: { job?: string; name: string }[] };
  release_dates?: { results?: { iso_3166_1: string; release_dates: ReleaseDateEntry[] }[] };
  "watch/providers"?: { results?: Record<string, { flatrate?: { provider_name: string }[] }> };
}

async function tmdbGet<T>(
  path: string,
  params: Record<string, string>,
  a: Pick<TmdbArgs, "apiKey" | "fetchImpl" | "budget">,
): Promise<T> {
  a.budget?.take();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", a.apiKey);
  const res = await (a.fetchImpl ?? fetch)(url.href);
  // The message deliberately omits the URL: it carries the key.
  if (!res.ok) throw new TmdbError(`TMDB ${path} returned HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

function hitDate(h: SearchHit): string {
  return h.release_date || h.first_air_date || "";
}

/**
 * Prefers exact title matches, then the most recent release. When a year hint exists the search is
 * already filtered by year, so the same rule just orders what is left.
 */
export function pickSearchHit(hits: SearchHit[], title: string): SearchHit | undefined {
  if (hits.length === 0) return undefined;
  const t = norm(title);
  const exact = hits.filter((h) => [h.title, h.original_title, h.name, h.original_name].some((n) => norm(n) === t));
  const pool = exact.length > 0 ? exact : hits;
  return [...pool].sort((a, b) => hitDate(b).localeCompare(hitDate(a)))[0];
}

const dateOnly = (iso: string) => iso.slice(0, 10);
const dayNumber = (iso: string) => Date.parse(`${dateOnly(iso)}T00:00:00Z`) / DAY_MS;

function earliestUsTheatricalDate(usReleases: ReleaseDateEntry[]): string | null {
  const theatrical = usReleases
    .filter((r) => (r.type === 3 || r.type === 2) && r.release_date)
    .sort((a, b) => dayNumber(a.release_date) - dayNumber(b.release_date));
  return theatrical[0] ? dateOnly(theatrical[0].release_date) : null;
}

export type MovieReleaseState = "Upcoming" | "In_Theaters_Wide" | "In_Theaters_Limited" | "Streaming" | "Published";

/** Spec 5.2 movie release state. Exported for tests. */
export function deriveMovieReleaseState(input: {
  usReleases: ReleaseDateEntry[];
  releaseDate: string | null;
  hasFlatrate: boolean;
  now: Date;
}): MovieReleaseState {
  const today = dayNumber(input.now.toISOString());
  const theatrical = input.usReleases.filter((r) => (r.type === 3 || r.type === 2) && r.release_date);
  if (theatrical.length > 0) {
    const earliest = Math.min(...theatrical.map((r) => dayNumber(r.release_date)));
    if (earliest > today) return "Upcoming";
  } else if (input.releaseDate && dayNumber(input.releaseDate) > today) {
    return "Upcoming";
  }
  if (!input.hasFlatrate) {
    const recent = theatrical.filter((r) => {
      const age = today - dayNumber(r.release_date);
      return age >= 0 && age <= 60;
    });
    if (recent.some((r) => r.type === 3)) return "In_Theaters_Wide";
    if (recent.some((r) => r.type === 2)) return "In_Theaters_Limited";
  }
  return input.hasFlatrate ? "Streaming" : "Published";
}

export function deriveTvReleaseState(d: { status?: string; in_production?: boolean }): "Ongoing_TV" | "Ended_TV" {
  if (d.status === "Ended" || d.status === "Canceled") return "Ended_TV";
  if (d.status === "Returning Series") return "Ongoing_TV";
  return d.in_production ? "Ongoing_TV" : "Ended_TV";
}

function formatRuntime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function accessDisplay(state: string, providers: string[], releaseDate: string | null): string {
  if (providers.length > 0) return `Streaming on ${providers.slice(0, 3).join(", ")}`;
  switch (state) {
    case "Upcoming":
      return releaseDate ? `Releases ${dateOnly(releaseDate)}` : "Upcoming";
    case "In_Theaters_Wide":
      return "In theaters";
    case "In_Theaters_Limited":
      return "In limited release";
    default:
      return "Not on US streaming";
  }
}

export async function fetchTmdbMetadata(a: TmdbArgs): Promise<TmdbResult> {
  const isMovie = a.mediaType === "Movie";
  const searchParams: Record<string, string> = { query: a.title, include_adult: "false" };
  if (a.yearHint != null) searchParams[isMovie ? "year" : "first_air_date_year"] = String(a.yearHint);
  const search = await tmdbGet<{ results?: SearchHit[] }>(isMovie ? "/search/movie" : "/search/tv", searchParams, a);
  const hit = pickSearchHit(search.results ?? [], a.title);
  if (!hit) return { kind: "not-found" };
  return fetchTmdbById({ ...a, tmdbId: String(hit.id) });
}

export interface TmdbByIdArgs {
  mediaType: "Movie" | "TV";
  tmdbId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  now: Date;
}

/** One details request by stored TMDB id (no search). Throws TmdbError on HTTP failure, so a 404 is an error here. */
export async function fetchTmdbById(a: TmdbByIdArgs): Promise<TmdbResult> {
  const isMovie = a.mediaType === "Movie";
  const d = await tmdbGet<Details>(
    `${isMovie ? "/movie" : "/tv"}/${encodeURIComponent(a.tmdbId)}`,
    {
      append_to_response: isMovie
        ? "release_dates,watch/providers,credits"
        : "external_ids,watch/providers,credits,content_ratings",
    },
    a,
  );

  const releaseDate = (isMovie ? d.release_date : d.first_air_date) || null;
  const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : null;
  const providers = (d["watch/providers"]?.results?.US?.flatrate ?? []).map((p) => p.provider_name);
  const poster = d.poster_path ? `${IMG}${d.poster_path}` : "";
  const imdbId = (isMovie ? d.imdb_id : (d.external_ids?.imdb_id ?? d.imdb_id)) || null;

  const hasTmdbScore = typeof d.vote_average === "number" && d.vote_average > 0 && (d.vote_count ?? 0) >= 10;
  const base: EnrichedFields = {
    tmdbId: String(d.id),
    imdbId,
    releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
    releaseDate,
    genresJson: JSON.stringify((d.genres ?? []).map((g) => g.name)),
    streamingProvidersJson: JSON.stringify(providers),
    posterImageUrl: poster,
    ...(hasTmdbScore
      ? {
          criticScore: Math.round(d.vote_average! * 100) / 10,
          criticScoreDisplay: `TMDB ${d.vote_average!.toFixed(1)}`,
        }
      : {}),
  };

  if (isMovie) {
    const us = d.release_dates?.results?.find((r) => r.iso_3166_1 === "US")?.release_dates ?? [];
    const state = deriveMovieReleaseState({ usReleases: us, releaseDate, hasFlatrate: providers.length > 0, now: a.now });
    const displayDate = state === "Upcoming" ? (earliestUsTheatricalDate(us) ?? releaseDate) : releaseDate;
    const directors = (d.credits?.crew ?? []).filter((c) => c.job === "Director").map((c) => c.name);
    const runtime = d.runtime && d.runtime > 0 ? d.runtime : null;
    return {
      kind: "ok",
      fields: {
        ...base,
        creator: [...new Set(directors)].join(", "),
        timeCommitmentMinutes: runtime,
        timeCommitmentDisplay: runtime ? formatRuntime(runtime) : "",
        releaseState: state,
        releaseAccessDisplay: accessDisplay(state, providers, displayDate),
        isAvailableNow: providers.length > 0 || state === "In_Theaters_Wide" || state === "In_Theaters_Limited",
      },
    };
  }

  const state = deriveTvReleaseState(d);
  const exec = (d.credits?.crew ?? []).find((c) => c.job === "Executive Producer")?.name;
  const creator = d.created_by?.[0]?.name ?? exec ?? "";
  const ep = d.episode_run_time?.[0];
  const seasons = d.number_of_seasons;
  return {
    kind: "ok",
    fields: {
      ...base,
      creator,
      timeCommitmentMinutes: ep && ep > 0 ? ep : null,
      timeCommitmentDisplay: seasons ? `${seasons} season${seasons === 1 ? "" : "s"}` : ep ? `${ep}m per episode` : "",
      releaseState: state,
      releaseAccessDisplay: accessDisplay(state, providers, releaseDate),
      isAvailableNow: providers.length > 0,
    },
  };
}
