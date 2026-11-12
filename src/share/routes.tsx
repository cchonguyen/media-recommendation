import { Hono } from "hono";
import { raw } from "hono/html";
import { and, asc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { curatedListItems, curatedLists, mediaItems } from "../db/schema";

// Public, read-only page. /share/* is a Cloudflare Access bypass path configured
// OUTSIDE the app (invariant 8). The app does no auth here, so this file must
// never fetch anything beyond the allowlist in SYSTEM_SPEC section 3, invariant 9.
// Every query uses an explicit column select. Never select a whole row.

const MAX_SLUG = 60;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ITEM_LIMIT = 100;

const HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=60",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const CSS = `
:root{--bg:#f6f6f4;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#dcdcd6;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#9a9aa2;--card:#1f1f23;--line:#33333a;--accent:#7aa2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.2rem 1rem}
h1{font-size:1.6rem;margin:.2rem 0 .4rem}
.desc{color:var(--muted);margin:0 0 1.2rem}
ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.7rem}
li{display:flex;gap:.8rem;background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:.7rem}
.rank{font-weight:700;color:var(--accent);min-width:1.8rem;font-size:1.2rem}
li img{width:60px;height:90px;object-fit:cover;border-radius:.3rem}
.t{font-weight:600}
.meta{color:var(--muted);font-size:.88rem}
.blurb{margin:.3rem 0 0}
.empty{color:var(--muted);font-style:italic}
footer{max-width:44rem;margin:0 auto;padding:1rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--line)}
footer a{color:var(--accent)}
`;

function Page(props: { title: string; children: unknown }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex, nofollow" />
          <title>{props.title}</title>
          <style>{raw(CSS)}</style>
        </head>
        <body>
          <main>{props.children as never}</main>
          <footer>
            Movie and TV data from <a href="https://www.themoviedb.org">TMDB</a>. This product uses the TMDB API but is
            not endorsed or certified by TMDB. Streaming availability data provided by{" "}
            <a href="https://www.justwatch.com">JustWatch</a>.
          </footer>
        </body>
      </html>
    </>
  );
}

function NotFound() {
  return (
    <Page title="Not found">
      <h1>Not found</h1>
      <p class="desc">This page does not exist.</p>
    </Page>
  );
}

export function createShareRoutes() {
  const share = new Hono<{ Bindings: { DB: D1Database } }>();

  share.get("/share/:slug", async (c) => {
    const slug = c.req.param("slug");
    for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
    if (slug.length === 0 || slug.length > MAX_SLUG || !SLUG_RE.test(slug)) return c.html(<NotFound />, 404);

    const db = drizzle(c.env.DB);
    const lists = await db
      .select({
        title: curatedLists.title,
        description: curatedLists.description,
        isPublic: curatedLists.isPublic,
      })
      .from(curatedLists)
      .where(eq(curatedLists.slug, slug))
      .limit(1);
    const list = lists[0];
    // Unknown and private are indistinguishable.
    if (!list || !list.isPublic) return c.html(<NotFound />, 404);

    const items = await db
      .select({
        rank: curatedListItems.rank,
        blurb: curatedListItems.blurb,
        title: mediaItems.title,
        creator: mediaItems.creator,
        releaseYear: mediaItems.releaseYear,
        posterImageUrl: mediaItems.posterImageUrl,
        myRating: mediaItems.myRating,
        personalTier: mediaItems.personalTier,
      })
      .from(curatedListItems)
      .innerJoin(curatedLists, eq(curatedLists.id, curatedListItems.listId))
      .innerJoin(mediaItems, eq(mediaItems.id, curatedListItems.mediaItemId))
      .where(and(eq(curatedLists.slug, slug), eq(curatedLists.isPublic, true), ne(mediaItems.status, "Archived")))
      .orderBy(asc(curatedListItems.rank))
      .limit(ITEM_LIMIT);

    return c.html(
      <Page title={list.title}>
        <h1>{list.title}</h1>
        {list.description ? <p class="desc">{list.description}</p> : null}
        {items.length === 0 ? (
          <p class="empty">This list is empty.</p>
        ) : (
          <ol>
            {items.map((i, n) => (
              <li>
                <span class="rank">{n + 1}</span>
                {i.posterImageUrl.startsWith("https://") ? (
                  <img src={i.posterImageUrl} alt="" loading="lazy" width="60" height="90" referrerpolicy="no-referrer" />
                ) : null}
                <div>
                  <div class="t">{i.title}</div>
                  <div class="meta">
                    {[i.creator, i.releaseYear === null ? "" : String(i.releaseYear)].filter(Boolean).join(" · ")}
                  </div>
                  {i.myRating !== null || i.personalTier ? (
                    <div class="meta">
                      {i.myRating !== null ? `Rating ${i.myRating}` : ""}
                      {i.myRating !== null && i.personalTier ? " · " : ""}
                      {i.personalTier ? `Tier ${i.personalTier}` : ""}
                    </div>
                  ) : null}
                  {i.blurb ? <p class="blurb">{i.blurb}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Page>,
    );
  });

  // Any other method (POST, PUT, DELETE...) never reaches the DB.
  share.all("/share/:slug", (c) => {
    for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
    c.header("Allow", "GET, HEAD");
    return c.text("Method not allowed", 405);
  });

  return share;
}
