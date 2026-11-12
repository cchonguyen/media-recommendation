import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { seed, setup } from "../intake/test-fixtures";
import { createUiRoutes } from "./now-next";

const NOW = new Date("2026-07-10T12:00:00Z");

function harness() {
  const { d1, db } = setup();
  const app = new Hono();
  app.route("/", createUiRoutes({ now: () => NOW }));
  return { db, get: (p: string) => app.request(p, {}, { DB: d1 }) };
}

describe("Now & Next UI", () => {
  it("renders headings, nav and header strip on an empty DB", async () => {
    const h = harness();
    const res = await h.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const s of ["Active", "Paused", "Up Next", "Pending Review", "Sweep Inbox Now", 'data-action="backup"', "/library/movies", "Completed Archive"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("Up Next is empty.");
  });

  it("renders seeded rows, escapes titles, and applies filters", async () => {
    const h = harness();
    await seed(h.db, { id: "a1", title: "<script>x</script>", status: "Active" });
    await seed(h.db, { id: "p1", title: "Paused One", status: "Paused", lastStatusChangeAt: "2026-07-05T12:00:00Z" });
    await seed(h.db, { id: "u1", title: "Short Show", status: "Up Next", mediaType: "TV", timeCommitmentMinutes: 20, streamingProvidersJson: '["Max"]' });
    await seed(h.db, { id: "u2", title: "Long Game", status: "Up Next", mediaType: "Game", timeCommitmentMinutes: null });
    await seed(h.db, { id: "c1", title: "Needs Review", status: "Completed", reviewDone: false });
    const html = await (await h.get("/")).text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("paused 5 days ago");
    expect(html).toContain("Needs Review");
    const f = await (await h.get("/?type=TV&streaming=max&time=le30")).text();
    expect(f).toContain("Short Show");
    expect(f).not.toContain("Long Game");
    const g = await (await h.get("/?time=gt600")).text();
    expect(g).toContain("Long Game");
    expect(g).not.toContain("Short Show");
  });
});

describe("Library UI", () => {
  async function lib() {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Alpha Movie", mediaType: "Movie", status: "Backlog" });
    await seed(h.db, { id: "m2", title: "Gone Movie", mediaType: "Movie", status: "Archived" });
    await seed(h.db, { id: "m3", title: "100%_Real", mediaType: "Movie", status: "Backlog" });
    await seed(h.db, { id: "t1", title: "Some Show", mediaType: "TV", status: "Backlog" });
    await seed(h.db, { id: "c1", title: "Finished Book", mediaType: "Book", status: "Completed", consumedYear: 2025 });
    return h;
  }

  it("every library URL returns 200 with its heading and nav links match", async () => {
    const h = await lib();
    const pages: [string, string][] = [
      ["movies", "Movies"], ["tv", "TV"], ["books", "Books"], ["games", "Games"],
      ["podcasts", "Podcasts"], ["one-offs", "One-Offs"], ["completed", "Completed Archive"],
    ];
    for (const [slug, heading] of pages) {
      const res = await h.get(`/library/${slug}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).toContain(`href="/library/${slug}"`);
    }
  });

  it("returns 404 with layout for unknown type", async () => {
    const h = await lib();
    const res = await h.get("/library/movie");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Sweep Inbox Now");
  });

  it("clamps pagination and handles hostile params", async () => {
    const h = await lib();
    for (const p of ["page=0", "page=99999", "page=abc", "page=-3"]) {
      const res = await h.get(`/library/movies?${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Alpha Movie");
    }
    for (const p of ["sort=evil;DROP", "dir=sideways", "q=%27;DROP%20TABLE%20media_items;--", "sort=title&dir=asc"]) {
      const res = await h.get(`/library/movies?${p}`);
      expect(res.status).toBe(200);
    }
    expect(await (await h.get("/library/movies")).text()).toContain("Alpha Movie");
  });

  it("hides Archived by default, shows with filter, escapes LIKE wildcards", async () => {
    const h = await lib();
    const def = await (await h.get("/library/movies")).text();
    expect(def).not.toContain("Gone Movie");
    expect(def).not.toContain("Some Show");
    expect(await (await h.get("/library/movies?status=Archived")).text()).toContain("Gone Movie");
    const q = await (await h.get("/library/movies?q=%25_")).text();
    expect(q).toContain("100%_Real");
    expect(q).not.toContain("Alpha Movie");
  });

  it("archive page shows only Completed", async () => {
    const h = await lib();
    const html = await (await h.get("/library/completed")).text();
    expect(html).toContain("Finished Book");
    expect(html).not.toContain("Alpha Movie");
    expect(await (await h.get("/library/completed?consumed_year=2024")).text()).not.toContain("Finished Book");
    expect(await (await h.get("/library/completed?type=Book")).text()).toContain("Finished Book");
  });
});
