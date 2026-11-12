import { getCachedValue, setCachedValue } from "../google/token";
import type { Db } from "../google/token";
import type { SubrequestBudget } from "../google/api";
import type { EnrichContext, EnrichOutcome, Enricher, EnrichmentEnv } from "./types";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const GAMES_URL = "https://api.igdb.com/v4/games";
const BEATS_URL = "https://api.igdb.com/v4/game_time_to_beats";
export const TWITCH_TOKEN_CACHE_KEY = "twitch_access_token";
const TOKEN_MARGIN_SECONDS = 300;

export class IgdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IgdbError";
  }
}

interface IgdbGame {
  id: number;
  name?: string;
  first_release_date?: number;
  genres?: { name: string }[];
  involved_companies?: { developer?: boolean; company?: { name?: string } }[];
  cover?: { image_id?: string };
  platforms?: { name: string }[];
  total_rating?: number;
  url?: string;
  summary?: string;
}

interface CallArgs {
  db: Db;
  env: EnrichmentEnv;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
  nowSeconds: number;
}

/** Reads the cached token, else requests one (1 subrequest) and caches it in system_kv. */
export async function getTwitchToken(a: CallArgs): Promise<string> {
  const cached = await getCachedValue(a.db, TWITCH_TOKEN_CACHE_KEY, a.nowSeconds);
  if (cached) return cached;
  a.budget?.take();
  const res = await (a.fetchImpl ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: a.env.TWITCH_CLIENT_ID ?? "",
      client_secret: a.env.TWITCH_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }).toString(),
  });
  if (!res.ok) throw new IgdbError(`Twitch token request returned HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new IgdbError("Twitch token response had no access_token", res.status);
  const ttl = Math.max(0, (body.expires_in ?? 3600) - TOKEN_MARGIN_SECONDS);
  await setCachedValue(a.db, TWITCH_TOKEN_CACHE_KEY, body.access_token, a.nowSeconds + ttl);
  return body.access_token;
}

async function igdbPost<T>(url: string, query: string, token: string, a: CallArgs): Promise<T> {
  a.budget?.take();
  const res = await (a.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "client-id": a.env.TWITCH_CLIENT_ID ?? "", authorization: `Bearer ${token}`, accept: "application/json" },
    body: query,
  });
  if (!res.ok) throw new IgdbError(`IGDB ${new URL(url).pathname} returned HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const yearOf = (g: IgdbGame) => (g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null);

/** Exact title first, then the year hint, then the most recent release. */
export function pickGame(games: IgdbGame[], title: string, yearHint: number | null): IgdbGame | undefined {
  if (games.length === 0) return undefined;
  const exact = games.filter((g) => norm(g.name) === norm(title));
  let pool = exact.length > 0 ? exact : games;
  if (yearHint != null) {
    const byYear = pool.filter((g) => yearOf(g) === yearHint);
    if (byYear.length > 0) pool = byYear;
  }
  return [...pool].sort((x, y) => (y.first_release_date ?? 0) - (x.first_release_date ?? 0))[0];
}

export function formatHours(minutes: number): string {
  return minutes >= 60 ? `~${Math.round(minutes / 60)} h` : `~${minutes} min`;
}

export const igdbEnricher: Enricher = {
  subrequestsNeeded: () => 3,
  hasCredentials: (env) => Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const a: CallArgs = {
      db: ctx.db,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
      budget: ctx.budget,
      nowSeconds: Math.floor(ctx.now.getTime() / 1000),
    };
    const token = await getTwitchToken(a);
    const title = ctx.row.title.replace(/["\\]/g, " ");
    const games = await igdbPost<IgdbGame[]>(
      GAMES_URL,
      `search "${title}"; fields name,first_release_date,genres.name,involved_companies.company.name,involved_companies.developer,cover.image_id,url,summary,platforms.name,total_rating; limit 5;`,
      token,
      a,
    );
    const g = pickGame(Array.isArray(games) ? games : [], ctx.row.title, ctx.row.yearHint);
    if (!g) return { kind: "not-found" };

    // Time to beat is optional: any failure leaves it empty.
    let minutes: number | null = null;
    try {
      const beats = await igdbPost<{ hastily?: number; normally?: number; completely?: number }[]>(
        BEATS_URL,
        `fields hastily,normally,completely; where game_id = ${g.id};`,
        token,
        a,
      );
      const secs = beats[0]?.normally ?? beats[0]?.hastily ?? beats[0]?.completely;
      if (secs && secs > 0) minutes = Math.max(1, Math.round(secs / 60));
    } catch {
      minutes = null;
    }

    const date = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : null;
    const today = ctx.now.toISOString().slice(0, 10);
    const developer = (g.involved_companies ?? []).find((c) => c.developer)?.company?.name ?? "";
    const score = typeof g.total_rating === "number" ? g.total_rating : null;
    return {
      kind: "ok",
      fields: {
        igdbId: String(g.id),
        releaseYear: yearOf(g),
        releaseDate: date,
        releaseState: date ? (date > today ? "Upcoming" : "Published") : "Unknown",
        genresJson: JSON.stringify((g.genres ?? []).map((x) => x.name)),
        creator: developer,
        posterImageUrl: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : "",
        criticScore: score === null ? null : Math.round(score * 10) / 10,
        criticScoreDisplay: score === null ? "" : `IGDB ${Math.round(score)}`,
        timeCommitmentMinutes: minutes,
        timeCommitmentDisplay: minutes ? formatHours(minutes) : "",
        categoryMetadataJson: JSON.stringify({ platforms: (g.platforms ?? []).map((p) => p.name) }),
      },
    };
  },
};
