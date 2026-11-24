import type { EnrichContext, EnrichOutcome, EnrichedFields, Enricher } from "./types";

const MAX_BODY_BYTES = 64 * 1024;
const URL_RE = /https?:\/\/[^\s<>"')]+/i;

/** Returns a safe http(s) URL, or null for other schemes and private or local hosts (SSRF guard). */
export function safeHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (host.startsWith("[")) {
    // Any IPv6 literal that is loopback, unspecified, unique-local, link-local or IPv4-mapped.
    const h = host.slice(1, -1);
    if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:")) return null;
    return u;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
  }
  return u;
}

export function findUrl(row: { sourceUrl: string | null; rawInput: string }): string | null {
  const fromSource = row.sourceUrl && URL_RE.test(row.sourceUrl) ? row.sourceUrl : null;
  return fromSource ?? URL_RE.exec(row.rawInput)?.[0] ?? null;
}

const isYouTube = (u: URL) => /(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname.toLowerCase());

function metaContent(html: string, prop: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key?.toLowerCase() !== prop) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const v = content?.[1] ?? content?.[2];
    if (v) return decodeEntities(v).trim();
  }
  return "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseOpenGraph(html: string) {
  return {
    title: metaContent(html, "og:title"),
    image: metaContent(html, "og:image"),
    site: metaContent(html, "og:site_name"),
    description: metaContent(html, "og:description"),
  };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, MAX_BODY_BYTES);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  // Not awaited: cancelling a teed or remote stream can wait on the rest of the body.
  void reader.cancel().catch(() => undefined);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(all.subarray(0, MAX_BODY_BYTES));
}

const timeout = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(5000) : undefined);

async function fetchMetadata(url: URL, ctx: EnrichContext): Promise<{ creator: string; poster: string; site: string; description: string; title: string }> {
  const f = ctx.fetchImpl ?? fetch;
  ctx.budget?.take();
  if (isYouTube(url)) {
    const o = new URL("https://www.youtube.com/oembed");
    o.searchParams.set("url", url.href);
    o.searchParams.set("format", "json");
    const res = await f(o.href, { signal: timeout() });
    if (!res.ok) return { creator: "", poster: "", site: "YouTube", description: "", title: "" };
    const j = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    return { creator: j.author_name ?? "", poster: j.thumbnail_url ?? "", site: "YouTube", description: "", title: j.title ?? "" };
  }
  const res = await f(url.href, { redirect: "follow", signal: timeout(), headers: { accept: "text/html" } });
  if (!res.ok) return { creator: "", poster: "", site: url.hostname, description: "", title: "" };
  const og = parseOpenGraph(await readCapped(res));
  return { creator: og.site, poster: og.image, site: og.site || url.hostname, description: og.description, title: og.title };
}

/** Sparse or failed metadata never fails the item: every path returns ok. */
export const oneOffEnricher: Enricher = {
  subrequestsNeeded: () => 1,
  hasCredentials: () => true,
  async enrich(ctx: EnrichContext): Promise<EnrichOutcome> {
    const fields: EnrichedFields = { releaseState: "Published", releaseAccessDisplay: "Published", isAvailableNow: true };
    const raw = findUrl(ctx.row);
    const url = raw ? safeHttpUrl(raw) : null;
    if (!url) return { kind: "ok", fields };
    fields.sourceUrl = url.href;
    try {
      const m = await fetchMetadata(url, ctx);
      fields.creator = m.creator;
      fields.posterImageUrl = m.poster;
      fields.categoryMetadataJson = JSON.stringify({ site: m.site, title: m.title, description: m.description.slice(0, 300) });
    } catch {
      // Network error, timeout or budget: keep what is known.
    }
    return { kind: "ok", fields };
  },
};
