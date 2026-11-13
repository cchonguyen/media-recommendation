import { Hono } from "hono";
import { raw } from "hono/html";
import { and, asc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { curatedListItems, curatedLists, mediaItems } from "../db/schema";
import { STYLES } from "../ui/styles";

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

function Page(props: { title: string; children: unknown }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en" data-accent="azure" data-density="comfortable">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex, nofollow" />
          <title>{props.title}</title>
          <style>{raw(STYLES)}</style>
        </head>
        <body>
          <main class="share-page">{props.children as never}</main>
          <footer class="share-foot">
            Movie and TV data from <a class="ui-link" href="https://www.themoviedb.org">TMDB</a>. This product uses the TMDB API but is
            not endorsed or certified by TMDB. Streaming availability data provided by{" "}
            <a class="ui-link" href="https://www.justwatch.com">JustWatch</a>.
          </footer>
        </body>
      </html>
    </>
  );
}

function NotFound() {
  return (
    <Page title="Not found">
      <h1 class="ui-display app-title">Not found</h1>
      <p class="ui-muted">This page does not exist.</p>
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
        <h1 class="ui-display app-title">{list.title}</h1>
        {list.description ? <p class="ui-muted">{list.description}</p> : null}
        {items.length === 0 ? (
          <p class="ui-missing">This list is empty.</p>
        ) : (
          <ol class="app-list">
            {items.map((i, n) => (
              <li class="ui-card share-item">
                <span class="share-rank">{n + 1}</span>
                {i.posterImageUrl.startsWith("https://") ? (
                  <img class="app-poster" src={i.posterImageUrl} alt="" loading="lazy" width="60" height="90" referrerpolicy="no-referrer" />
                ) : null}
                <div class="app-card-body">
                  <div>
                    <strong>{i.title}</strong>
                  </div>
                  <div class="ui-muted">
                    {[i.creator, i.releaseYear === null ? "" : String(i.releaseYear)].filter(Boolean).join(" · ")}
                  </div>
                  {i.myRating !== null || i.personalTier ? (
                    <div class="ui-data">
                      {i.myRating !== null ? `Rating ${i.myRating}` : ""}
                      {i.myRating !== null && i.personalTier ? " · " : ""}
                      {i.personalTier ? `Tier ${i.personalTier}` : ""}
                    </div>
                  ) : null}
                  {i.blurb ? <p>{i.blurb}</p> : null}
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
