import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { seed, setup } from "../intake/test-fixtures";
import { curatedListItems, curatedLists } from "../db/schema";
import { createUiRoutes } from "./now-next";
import { setCachedValue } from "../google/token";
import { CLIENT_SCRIPT } from "./client";
import { STYLES } from "./styles";
import { parseCriticScore } from "./controls";
import { readFileSync } from "node:fs";

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
    for (const s of ['class="app-page"', "app-menu-wrap", '<h1 class="ui-display app-title">Now &amp; Next</h1>']) {
      expect(html).toContain(s);
    }
    // The inlined kit CSS also names the class, so count in the body only.
    expect(html.slice(html.indexOf("<body>")).split("ui-btn--primary").length - 1).toBe(1);
    for (const s of ['class="card"', 'class="row"', 'class="primary"']) {
      expect(html).not.toContain(s);
    }
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

describe("AppShell layout", () => {
  it("renders the shell with accent, density, sidebar, tab bar and containers", async () => {
    const html = await (await harness().get("/")).text();
    for (const s of ['data-accent="azure"', 'data-density="comfortable"', 'class="ui-sidebar"', 'class="ui-tabbar"', 'aria-current="page"', 'id="toasts"', 'id="notices"', "fonts.googleapis.com"]) {
      expect(html).toContain(s);
    }
    // The kit CSS itself mentions data-theme selectors, so check the attribute on the tags only.
    expect(html.slice(0, html.indexOf("<head>"))).not.toContain("data-theme");
    expect(html).not.toContain('id="toast"');
    // The kit CSS also mentions the attribute, so count in the body only: sidebar plus tab bar.
    expect(html.slice(html.indexOf("<body>")).split('aria-current="page"').length - 1).toBe(2);
  });
});

describe("Backup button", () => {
  it("is enabled and shows the last backup time", async () => {
    const h = harness();
    const never = await (await h.get("/")).text();
    expect(never).toContain("Last backup: never");
    expect(never).not.toContain("Coming soon");
    expect(never).toMatch(/<button[^>]*data-action="backup"/);
    expect(never).not.toMatch(/data-action="backup"[^>]*aria-disabled/);
    await setCachedValue(h.db, "last_backup_at", "2026-07-09T08:30:00.000Z", 4102444800);
    await setCachedValue(h.db, "last_inbox_sync", "2026-07-10T11:00:00.000Z", 4102444800);
    const html = await (await h.get("/")).text();
    expect(html).toContain("Last backup: 2026-07-09 08:30 UTC");
    expect(html).toContain("Last inbox sync: 2026-07-10 11:00 UTC");
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
      expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
      expect(html).toContain(`href="/library/${slug}"`);
      expect(html).not.toContain('class="tablewrap"');
      expect(html).not.toContain('table class="lib"');
      if (slug === "completed") expect(html).not.toContain("Library sections");
      else for (const s of ["movies", "tv", "books", "games", "podcasts", "one-offs"]) expect(html).toContain(`href="/library/${s}"`);
    }
  });

  it("type page shows the pill sub-nav with the current pill marked", async () => {
    const h = await lib();
    const html = await (await h.get("/library/movies")).text();
    expect(html).toContain(`<nav class="app-subnav"`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("ui-pill--active");
    expect(html).toContain("table-scroll");
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

describe("Lists UI", () => {
  async function withList() {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Item One", status: "Completed" });
    await seed(h.db, { id: "m2", title: "Gone One", status: "Archived" });
    await h.db.insert(curatedLists).values({ id: "lst_abc123", slug: "my-list", title: "<b>My List</b>", description: "d", isPublic: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    await h.db.insert(curatedListItems).values([
      { id: "l1", listId: "lst_abc123", mediaItemId: "m1", rank: 1, blurb: "nice", createdAt: "2026-01-01" },
      { id: "l2", listId: "lst_abc123", mediaItemId: "m2", rank: 2, blurb: "hidden", createdAt: "2026-01-01" },
    ]);
    return h;
  }

  it("renders /lists with create form, draft box and rows", async () => {
    const h = await withList();
    const res = await h.get("/lists");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const s of ["Create List", "Draft List with AI", "Generate", 'data-action="list-create"', 'data-action="draft"', 'data-share-slug="my-list"', "Copy", "/lists/lst_abc123", "Delete"]) {
      expect(html).toContain(s);
    }
    expect(html).not.toContain("<b>My List</b>");
    expect(html).toContain("&lt;b&gt;My List&lt;/b&gt;");
    expect(html).toMatch(/<h1[^>]*>Lists<\/h1>/);
    expect(html).toContain('role="switch"');
    expect(html).toContain("ui-switch__state");
    for (const s of ['class="row"', 'class="rate"', "style="]) expect(html).not.toContain(s);
  });

  it("renders the edit page without archived items, and 404s unknown ids", async () => {
    const h = await withList();
    const html = await (await h.get("/lists/lst_abc123")).text();
    expect(html).toContain("Item One");
    expect(html).toContain("nice");
    expect(html).not.toContain("Gone One");
    for (const s of ["Add items", 'data-action="list-save"', 'data-action="row-up"', "Delete list", 'data-action="pick"']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('aria-label="Move up"');
    for (const s of ['class="row"', 'class="rate"', "style="]) expect(html).not.toContain(s);
    const nf = await h.get("/lists/lst_nope00");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain("List not found");
  });

  it("renders an empty /lists", async () => {
    const h = harness();
    expect(await (await h.get("/lists")).text()).toContain("No lists yet");
  });
});

describe("sweeps panel", () => {
  it("shows Last sweeps and the Test parse button on the home page", async () => {
    const html = await (await harness().get("/")).text();
    expect(html).toContain("Last sweeps");
    expect(html).toContain('data-action="test-parse"');
    expect(html).toContain('id="sweeps"');
  });

  it("client script loads the ledger and says nothing was saved", () => {
    expect(() => new Function(CLIENT_SCRIPT)).not.toThrow();
    expect(CLIENT_SCRIPT).toContain("/api/sweeps");
    expect(CLIENT_SCRIPT).toContain("nothing was saved");
  });
});

describe("client script", () => {
  it("is valid JavaScript and gives plain-English sweep results", () => {
    expect(() => new Function(CLIENT_SCRIPT)).not.toThrow();
    for (const text of ["Sweeping the inbox", "not configured", "The inbox is empty", "already seen"]) {
      expect(CLIENT_SCRIPT).toContain(text);
    }
    expect(CLIENT_SCRIPT).not.toContain("Sweep done: ");
  });

  it("uses kit toast, notice and dialog with no native confirm", () => {
    expect(() => new Function(CLIENT_SCRIPT)).not.toThrow();
    expect(CLIENT_SCRIPT).not.toContain("window.confirm");
    expect(CLIENT_SCRIPT).not.toContain("alert(");
    expect(CLIENT_SCRIPT).not.toContain("9000");
    for (const text of ["ui-toast", "ui-notice", "alertdialog", "6000", "Archive this item?", "Delete this list?", "sessionStorage"]) {
      expect(CLIENT_SCRIPT).toContain(text);
    }
  });
});

describe("design system guards", () => {
  async function pages() {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Alpha Movie", mediaType: "Movie", status: "Backlog" });
    await seed(h.db, { id: "c1", title: "Finished Book", mediaType: "Book", status: "Completed", consumedYear: 2025 });
    await h.db.insert(curatedLists).values({ id: "lst_abc123", slug: "my-list", title: "My List", description: "d", isPublic: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    await h.db.insert(curatedListItems).values([{ id: "l1", listId: "lst_abc123", mediaItemId: "c1", rank: 1, blurb: "nice", createdAt: "2026-01-01" }]);
    const out: [string, string][] = [];
    for (const p of ["/", "/library/movies", "/library/completed", "/lists", "/lists/lst_abc123"]) {
      const res = await h.get(p);
      expect(res.status).toBe(200);
      out.push([p, await res.text()]);
    }
    return out;
  }

  it("uses kit classes only and no legacy classes or inline styles", async () => {
    for (const [p, html] of await pages()) {
      const tags = (name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
      for (const t of tags("button")) expect(t, `${p} ${t}`).toMatch(/class="[^"]*\bui-(btn|icon-btn|toast__action|segmented__opt|filter-toggle)\b/);
      for (const t of tags("select")) expect(t, `${p} ${t}`).toMatch(/class="[^"]*\bui-(select|filter-select)\b/);
      for (const t of tags("textarea")) expect(t, `${p} ${t}`).toMatch(/class="[^"]*\bui-textarea\b/);
      for (const t of tags("input")) {
        if (/type="text"/.test(t)) expect(t, `${p} ${t}`).toMatch(/class="[^"]*\bui-input\b/);
      }
      expect(html, p).not.toContain("style=");
      for (const s of ['class="card"', 'class="row"', 'class="list"', 'class="pill"', 'class="meta"', 'class="actions"', 'class="empty"', 'class="primary"', "tablewrap", 'table class="lib"']) {
        expect(html, `${p} ${s}`).not.toContain(s);
      }
    }
  });

  it("has exactly one h1 and at most one primary button per page", async () => {
    for (const [p, html] of await pages()) {
      expect((html.match(/<h1\b/g) ?? []).length, p).toBe(1);
      expect((html.match(/class="[^"]*\bui-btn--primary\b/g) ?? []).length, p).toBeLessThanOrEqual(1);
    }
  });

  it("source files use tokens, not hex colours", () => {
    for (const f of ["app-css.ts", "layout.tsx", "now-next.tsx", "library.tsx", "lists.tsx", "controls.tsx"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src.match(/[:\s(,]#[0-9a-fA-F]{3,8}\b/g), f).toBeNull();
    }
  });

  it("Library table uses the kit's compact cells and inline Rating/Tier pair", async () => {
    const lib = (await pages()).find(([p]) => p === "/library/movies")![1];
    expect(lib).toContain('class="app-table ui-table"');
    expect(lib).toContain("ui-control-pair");
    expect(STYLES).toContain("--control-h-compact");
    expect(STYLES).toContain(".ui-control-pair{display:flex;flex-wrap:nowrap");
    expect(STYLES).not.toContain(".app-table .rating-cell");
  });

  it("Library and Now & Next use compact Type column 1, wide Title with tooltip, sticky icon Archive, star ratings, and icon+text Status", async () => {
    const all = await pages();
    const now = all.find(([p]) => p === "/")![1];
    const lib = all.find(([p]) => p === "/library/movies")![1];
    const arch = all.find(([p]) => p === "/library/completed")![1];

    // Type column is first in both Library and Archive tables and uses icon menu picker
    expect(lib).toMatch(/<thead>\s*<tr>\s*<th class="app-col-type">Type<\/th>/);
    expect(arch).toMatch(/<thead>\s*<tr>\s*<th class="app-col-type">Type<\/th>/);
    expect(lib).toContain('data-menu-variant="icon"');
    expect(lib).toContain('title="Movie"');
    expect(arch).toContain('data-menu-variant="icon"');
    expect(arch).toContain('title="Book"');

    // Top Library sub-nav pills include icons for every media type
    const subnavMatch = lib.match(/<nav class="app-subnav"[\s\S]*?<\/nav>/);
    expect(subnavMatch).not.toBeNull();
    const subnavLinks = subnavMatch![0].match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(subnavLinks.length).toBe(6);
    for (const link of subnavLinks) expect(link).toContain("<svg ");

    // Title input is twice as wide (20rem) and has full-name tooltip wrapper
    expect(STYLES).toContain(".app-table .app-title-input{min-width:20rem}");
    expect(lib).toContain('class="app-title-wrap" data-tooltip="Alpha Movie"');
    expect(lib).toContain('class="ui-input app-title-input"');

    // Archive button is icon-only inside sticky right column
    expect(STYLES).toContain("position:sticky;right:0");
    expect(lib).toContain('<td class="app-col-sticky-right"><button type="button" class="ui-icon-btn" data-action="archive"');

    // Ratings use star buttons instead of numeric select dropdowns
    expect(lib).toContain('class="app-stars"');
    expect(lib).toContain('data-action="star-rate"');
    expect(arch).toContain('class="app-stars"');
    expect(now).toContain('class="app-stars"');

    // Status uses icon + text menu trigger with tone class
    expect(lib).toContain("app-status-select--neutral");
    expect(lib).toContain('data-action="open-menu"');
    expect(lib).toContain('aria-haspopup="listbox"');
  });

  it("Library and Completed Archive adopt the Harness UI Filters pattern", async () => {
    const h = harness();
    await seed(h.db, { id: "m1", title: "Tier S Movie", mediaType: "Movie", status: "Backlog", personalTier: "S", myRating: 4.5, personalNotes: "Must watch" });
    await seed(h.db, { id: "m2", title: "Unrated Movie", mediaType: "Movie", status: "Backlog", personalTier: null, myRating: null, personalNotes: "" });
    await seed(h.db, { id: "c1", title: "Reviewed Book", mediaType: "Book", status: "Completed", consumedYear: 2025, myRating: 5, reviewText: "Great read" });
    await seed(h.db, { id: "c2", title: "Unreviewed Book", mediaType: "Book", status: "Completed", consumedYear: 2024, myRating: null, reviewText: "" });

    expect(STYLES).toContain(".ui-filter-bar");
    expect(STYLES).toContain(".ui-filter-panel");

    const libDefault = await (await h.get("/library/movies")).text();
    expect(libDefault).toContain('class="ui-filter-bar"');
    expect(libDefault).toContain("ui-filter-trigger");
    expect(libDefault).toContain('class="ui-filter-panel" id="filter-panel" hidden');
    expect(libDefault).toContain("app-filter-menu");
    expect(libDefault).toContain("ui-filter-toggle");
    expect(libDefault).toContain("data-menu-options");

    const libFiltered = await (await h.get("/library/movies?tier=S&has_notes=yes")).text();
    expect(libFiltered).toContain("Filters (2)");
    expect(libFiltered).toContain('aria-expanded="true"');
    expect(libFiltered).toContain("ui-filter-trigger--active");
    expect(libFiltered).toContain("app-filter-chip");
    expect(libFiltered).toContain("Tier S Movie");
    expect(libFiltered).not.toContain("Unrated Movie");

    const archFiltered = await (await h.get("/library/completed?rated=yes&has_review=yes")).text();
    expect(archFiltered).toContain("Filters (2)");
    expect(archFiltered).toContain("Reviewed Book");
    expect(archFiltered).not.toContain("Unreviewed Book");
  });

  it("STYLES carries the azure accent and Newsreader, and no legacy block", () => {
    expect(STYLES).toContain('[data-accent="azure"]');
    expect(STYLES).toContain("Newsreader");
    expect(STYLES).not.toContain("LEGACY");
  });

  it("formats critic scores with bold value, spaced denominator, and quieter right-side source", async () => {
    expect(parseCriticScore("TMDB 7.8")).toEqual([{ val: "7.8", denom: " / 10", source: "TMDB" }]);
    expect(parseCriticScore("OL 4.5/5")).toEqual([{ val: "4.5", denom: " / 5", source: "OL" }]);
    expect(parseCriticScore("IGDB 90")).toEqual([{ val: "90", denom: " / 100", source: "IGDB" }]);
    expect(parseCriticScore("RT 83% · MC 74")).toEqual([
      { val: "83", denom: "%", source: "RT" },
      { val: "74", denom: " / 100", source: "MC" },
    ]);

    const h = harness();
    await seed(h.db, { id: "m1", title: "Dune", mediaType: "Movie", status: "Up Next", criticScoreDisplay: "TMDB 7.8" });
    await seed(h.db, { id: "b1", title: "Piranesi", mediaType: "Book", status: "Backlog", criticScoreDisplay: "OL 4.5/5" });
    const nowHtml = await (await h.get("/")).text();
    const libHtml = await (await h.get("/library/books")).text();
    expect(nowHtml).toContain('<strong class="app-score__val">7.8</strong><span class="app-score__denom"> / 10</span></span><span class="app-score__src">TMDB</span>');
    expect(libHtml).toContain('<strong class="app-score__val">4.5</strong><span class="app-score__denom"> / 5</span></span><span class="app-score__src">OL</span>');
  });
});
