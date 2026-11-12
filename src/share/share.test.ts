import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { curatedListItems, curatedLists } from "../db/schema";
import { seed, setup } from "../intake/test-fixtures";
import { createShareRoutes } from "./routes";

const ISO = "2026-01-01T00:00:00.000Z";
const SENT = {
  notes: "SENTINEL_NOTES_91ac",
  review: "SENTINEL_REVIEW_77bd",
  raw: "SENTINEL_RAW_55ce",
  src: "https://SENTINEL-SOURCE-33df.example/x",
  alt: "SENTINEL_ALT_12e0",
  rec: "SENTINEL_RECOMMENDER_88f1",
  tmdb: "SENTINEL_TMDB_99a2",
  imdb: "SENTINEL_IMDB_44b3",
  amazon: "SENTINEL_AMAZON_66c4",
};

function harness() {
  const { d1, db } = setup();
  let queries = 0;
  const orig = d1.prepare.bind(d1);
  (d1 as unknown as { prepare: unknown }).prepare = (sql: string) => {
    queries++;
    return orig(sql);
  };
  const app = new Hono();
  app.route("/", createShareRoutes());
  return {
    db,
    queries: () => queries,
    req: (p: string, init?: RequestInit) => app.request(p, init, { DB: d1 }),
  };
}

type H = ReturnType<typeof harness>;

async function mkList(h: H, id: string, slug: string, isPublic: boolean, items: { mid: string; blurb: string }[] = []) {
  await h.db.insert(curatedLists).values({ id, slug, title: `List ${slug}`, description: "A fine list", isPublic, createdAt: ISO, updatedAt: ISO });
  for (const [i, it] of items.entries()) {
    await h.db.insert(curatedListItems).values({ id: `${id}_${i}`, listId: id, mediaItemId: it.mid, rank: i + 1, blurb: it.blurb, createdAt: ISO });
  }
}

describe("GET /share/:slug", () => {
  it("leaks none of the private columns and shows the allowlisted ones", async () => {
    const h = harness();
    await seed(h.db, {
      id: "m1",
      title: "Public Title",
      creator: "Jane Director",
      releaseYear: 1999,
      myRating: 4.5,
      personalTier: "S",
      posterImageUrl: "https://img.example/p.jpg",
      personalNotes: SENT.notes,
      reviewText: SENT.review,
      rawInput: SENT.raw,
      sourceUrl: SENT.src,
      alternativeMatchesNote: SENT.alt,
      recommenderName: SENT.rec,
      tmdbId: SENT.tmdb,
      imdbId: SENT.imdb,
      amazonLink: SENT.amazon,
      status: "Completed",
      mediaType: "Game",
    });
    await mkList(h, "lst_aaaaaa", "best-of", true, [{ mid: "m1", blurb: "Blurb text here" }]);
    const res = await h.req("/share/best-of");
    expect(res.status).toBe(200);
    const body = await res.text();
    const headers = JSON.stringify([...res.headers.entries()]);
    for (const s of Object.values(SENT)) {
      expect(body).not.toContain(s);
      expect(headers).not.toContain(s);
    }
    expect(body).not.toContain("Game");
    expect(body).not.toContain("Completed");
    expect(body).not.toContain("m1");
    for (const s of ["Public Title", "Jane Director", "1999", "4.5", "Tier S", "Blurb text here", "List best-of", "A fine list", "https://img.example/p.jpg"]) {
      expect(body).toContain(s);
    }
    expect(body).toContain("Movie and TV data from");
    expect(body).toContain("This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data provided by");
    expect(body).toContain('href="https://www.themoviedb.org"');
    expect(body).toContain('href="https://www.justwatch.com"');
    expect(body).not.toContain("<script");
  });

  it("sets the security headers", async () => {
    const h = harness();
    await mkList(h, "lst_aaaaaa", "pub", true);
    for (const path of ["/share/pub", "/share/nope"]) {
      const res = await h.req(path);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    }
  });

  it("private list and unknown slug give an identical 404", async () => {
    const h = harness();
    await mkList(h, "lst_aaaaaa", "secret-list", false, []);
    const a = await h.req("/share/secret-list");
    const b = await h.req("/share/does-not-exist");
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const [ta, tb] = [await a.text(), await b.text()];
    expect(ta).toBe(tb);
    expect(ta).not.toContain("secret-list");
    expect(ta).not.toContain("List secret-list");
    expect(ta).toContain("TMDB");
  });

  it("invalid slugs 404 without any DB query", async () => {
    const h = harness();
    for (const s of ["Bad_Slug", "UPPER", "a--b", "-a", "a-", "a%20b", "a.b", "x".repeat(61), "%27%3BDROP", "a%00b"]) {
      const res = await h.req(`/share/${s}`);
      expect(res.status).toBe(404);
    }
    expect(h.queries()).toBe(0);
  });

  it("excludes Archived items and escapes titles", async () => {
    const h = harness();
    await seed(h.db, { id: "m1", title: "<script>alert(1)</script>", status: "Completed" });
    await seed(h.db, { id: "m2", title: "Archived Gem", status: "Archived" });
    await mkList(h, "lst_aaaaaa", "xss", true, [
      { mid: "m1", blurb: "<img src=x onerror=alert(2)>" },
      { mid: "m2", blurb: "gone" },
    ]);
    const body = await (await h.req("/share/xss")).text();
    expect(body).not.toContain("Archived Gem");
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<img src=x");
  });

  it("renders poster images only for https URLs", async () => {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Js", posterImageUrl: "javascript:alert(1)" });
    await seed(h.db, { id: "m2", title: "Http", posterImageUrl: "http://insecure.example/p.jpg" });
    await seed(h.db, { id: "m3", title: "Https", posterImageUrl: "https://ok.example/p.jpg" });
    await mkList(h, "lst_aaaaaa", "posters", true, [
      { mid: "m1", blurb: "" },
      { mid: "m2", blurb: "" },
      { mid: "m3", blurb: "" },
    ]);
    const body = await (await h.req("/share/posters")).text();
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("http://insecure");
    expect(body.match(/<img /g)?.length).toBe(1);
    expect(body).toContain("https://ok.example/p.jpg");
  });

  it("orders by rank, uses two reads, and answers HEAD", async () => {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Second" });
    await seed(h.db, { id: "m2", title: "First" });
    await mkList(h, "lst_aaaaaa", "ordered", true, [
      { mid: "m2", blurb: "" },
      { mid: "m1", blurb: "" },
    ]);
    const before = h.queries();
    const body = await (await h.req("/share/ordered")).text();
    expect(h.queries() - before).toBe(2);
    expect(body.indexOf("First")).toBeLessThan(body.indexOf("Second"));
    const head = await h.req("/share/ordered", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("does not serve other methods and never queries for them", async () => {
    const h = harness();
    await mkList(h, "lst_aaaaaa", "x", true);
    const before = h.queries();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await h.req("/share/x", { method, body: "{}" });
      expect([404, 405]).toContain(res.status);
    }
    expect((await h.req("/share/x", { method: "POST" })).status).toBe(405);
    expect(h.queries()).toBe(before);
  });
});

describe("share source static guard", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  it("finds the source files", () => {
    expect(files).toContain("routes.tsx");
  });
  it("never selects whole rows or private columns", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const bad of ["select()", "personalNotes", "reviewText", "rawInput", "alternativeMatchesNote", "sourceUrl", "personal_notes", "review_text", "raw_input", "source_url", "alternative_matches_note"]) {
        expect(src.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    }
  });
});
