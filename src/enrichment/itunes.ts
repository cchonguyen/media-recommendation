import type { EnrichContext, EnrichOutcome, Enricher } from "./types";

interface Podcast {
  collectionId?: number;
  collectionName?: string;
  trackName?: string;
  artistName?: string;
  feedUrl?: string;
  trackCount?: number;
  artworkUrl600?: string;
  genres?: string[];
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/** Exact name first, else the first result (iTunes relevance order). */
export function pickPodcast(results: Podcast[], title: string): Podcast | undefined {
  const usable = results.filter((r) => r.collectionId != null);
  return usable.find((r) => norm(r.collectionName) === norm(title) || norm(r.trackName) === norm(title)) ?? usable[0];
}

export const itunesEnricher: Enricher = {
  subrequestsNeeded: () => 1,
  hasCredentials: () => true,
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", ctx.row.title);
    url.searchParams.set("media", "podcast");
    url.searchParams.set("entity", "podcast");
    url.searchParams.set("limit", "5");
    ctx.budget?.take();
    const res = await (ctx.fetchImpl ?? fetch)(url.href);
    if (!res.ok) throw new Error(`iTunes search returned HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Podcast[] };
    const p = pickPodcast(body.results ?? [], ctx.row.title);
    if (!p) return { kind: "not-found" };
    const eps = p.trackCount && p.trackCount > 0 ? p.trackCount : null;
    return {
      kind: "ok",
      fields: {
        itunesId: String(p.collectionId),
        creator: p.artistName ?? "",
        genresJson: JSON.stringify((p.genres ?? []).filter((g) => g !== "Podcasts")),
        timeCommitmentDisplay: eps ? `${eps} episodes` : "",
        posterImageUrl: p.artworkUrl600 ?? "",
        categoryMetadataJson: JSON.stringify({ feedUrl: p.feedUrl ?? "" }),
        releaseState: "Published",
        releaseAccessDisplay: "Published",
        isAvailableNow: true,
      },
    };
  },
};
