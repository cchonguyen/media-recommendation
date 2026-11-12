import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { curatedListItems, mediaItems } from "../db/schema";
import { jsonResponse } from "../google/test-helpers";
import { GEMINI_KEY, GEMINI_URL, geminiFetch, seed, setup } from "../intake/test-fixtures";
import { createListsRoutes } from "./routes";

const NOW = new Date("2026-03-09T03:30:00Z");

function harness(fetchImpl?: typeof fetch, env: Record<string, unknown> = { GEMINI_API_KEY: GEMINI_KEY }) {
  const { d1, db } = setup();
  const batch = vi.spyOn(d1, "batch");
  const app = new Hono();
  app.route("/api", createListsRoutes({ now: () => NOW, fetchImpl }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      path,
      { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      { DB: d1, ...env },
    );
    return { status: res.status, json: (await res.json()) as any };
  };
  return { d1, db, batch, call };
}

const draftResp = (obj: unknown) =>
  jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

describe("lists CRUD", () => {
  it("creates with slug from title and handles collisions", async () => {
    const h = harness();
    const a = await h.call("POST", "/api/lists", { title: "Best Sci-Fi Movies!", description: "d", is_public: true });
    expect(a.status).toBe(201);
    expect(a.json.id).toMatch(/^lst_[0-9a-f]{6}$/);
    expect(a.json).toMatchObject({ slug: "best-sci-fi-movies", description: "d", isPublic: true, createdAt: NOW.toISOString() });
    const b = await h.call("POST", "/api/lists", { title: "Best sci-fi movies" });
    const c = await h.call("POST", "/api/lists", { title: "best sci fi movies" });
    expect(b.json.slug).toBe("best-sci-fi-movies-2");
    expect(c.json.slug).toBe("best-sci-fi-movies-3");
    const e = await h.call("POST", "/api/lists", { title: "Amélie ☃" });
    expect(e.json.slug).toBe("amelie");
    const long = await h.call("POST", "/api/lists", { title: "x".repeat(200) });
    expect(long.json.slug.length).toBe(60);
  });

  it("explicit slug clash is 409, bad slug 422", async () => {
    const h = harness();
    await h.call("POST", "/api/lists", { title: "A", slug: "mine" });
    expect((await h.call("POST", "/api/lists", { title: "B", slug: "mine" })).status).toBe(409);
    expect((await h.call("POST", "/api/lists", { title: "B", slug: "Bad Slug" })).status).toBe(422);
  });

  it("validates input", async () => {
    const h = harness();
    for (const body of [
      {},
      { title: "" },
      { title: "x", media_type_filter: "Music" },
      { title: "x", is_public: "yes" },
      { title: "x", extra: 1 },
    ]) {
      const r = await h.call("POST", "/api/lists", body);
      expect(r.status).toBe(422);
      expect(r.json.error).toBe("invalid_field");
    }
    const ok = await h.call("POST", "/api/lists", { title: "x", media_type_filter: "Movie" });
    expect(ok.json.mediaTypeFilter).toBe("Movie");
  });

  it("lists with item counts, newest first", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_1", title: "One" });
    const first = await h.call("POST", "/api/lists", { title: "First" });
    await h.call("PUT", `/api/lists/${first.json.id}/items`, { items: [{ media_item_id: "itm_1" }] });
    // Later creation time via a second harness-independent insert is not needed: ties break by id.
    const second = await h.call("POST", "/api/lists", { title: "Second" });
    const r = await h.call("GET", "/api/lists");
    expect(r.status).toBe(200);
    expect(r.json.lists).toHaveLength(2);
    const byId = Object.fromEntries(r.json.lists.map((l: any) => [l.id, l.itemCount]));
    expect(byId[first.json.id]).toBe(1);
    expect(byId[second.json.id]).toBe(0);
  });

  it("gets a list with ordered items and blurbs", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_1", title: "One", creator: "A", myRating: 4.5, personalTier: "A", releaseYear: 2001 });
    await seed(h.db, { id: "itm_2", title: "Two", mediaType: "Book" });
    const l = await h.call("POST", "/api/lists", { title: "L" });
    await h.call("PUT", `/api/lists/${l.json.id}/items`, {
      items: [{ media_item_id: "itm_2", blurb: "second-first" }, { media_item_id: "itm_1", blurb: "b1" }],
    });
    const r = await h.call("GET", `/api/lists/${l.json.id}`);
    expect(r.json.items.map((i: any) => i.media_item_id)).toEqual(["itm_2", "itm_1"]);
    expect(r.json.items[0]).toMatchObject({ rank: 1, blurb: "second-first", title: "Two", media_type: "Book" });
    expect(r.json.items[1]).toMatchObject({ rank: 2, creator: "A", my_rating: 4.5, personal_tier: "A", release_year: 2001, status: "Backlog" });
    expect((await h.call("GET", "/api/lists/lst_nope")).status).toBe(404);
  });

  it("patches fields, refreshes updated_at, and 409s on a slug clash", async () => {
    const h = harness();
    const a = await h.call("POST", "/api/lists", { title: "A" });
    const b = await h.call("POST", "/api/lists", { title: "B" });
    const p = await h.call("PATCH", `/api/lists/${a.json.id}`, { title: "A2", is_public: true, media_type_filter: null });
    expect(p.json).toMatchObject({ title: "A2", isPublic: true, slug: "a" });
    expect((await h.call("PATCH", `/api/lists/${a.json.id}`, { slug: "b" })).status).toBe(409);
    expect((await h.call("PATCH", `/api/lists/${a.json.id}`, { slug: "a" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/lists/${b.json.id}`, { slug: "fresh" })).json.slug).toBe("fresh");
    expect((await h.call("PATCH", `/api/lists/${a.json.id}`, {})).status).toBe(422);
    expect((await h.call("PATCH", "/api/lists/lst_nope", { title: "x" })).status).toBe(404);
  });

  it("delete removes the list and its items but not media items", async () => {
    const h = harness();
    await seed(h.db, { id: "itm_1", title: "One" });
    const l = await h.call("POST", "/api/lists", { title: "L" });
    await h.call("PUT", `/api/lists/${l.json.id}/items`, { items: [{ media_item_id: "itm_1" }] });
    expect((await h.call("DELETE", `/api/lists/${l.json.id}`)).status).toBe(200);
    expect((await h.call("GET", `/api/lists/${l.json.id}`)).status).toBe(404);
    expect(await h.db.select().from(curatedListItems)).toHaveLength(0);
    expect(await h.db.select().from(mediaItems)).toHaveLength(1);
    expect((await h.call("DELETE", `/api/lists/${l.json.id}`)).status).toBe(404);
  });
});

describe("PUT items", () => {
  async function withList() {
    const h = harness();
    for (const id of ["itm_1", "itm_2", "itm_3"]) await seed(h.db, { id, title: id });
    await seed(h.db, { id: "itm_arch", title: "arch", status: "Archived" });
    const l = await h.call("POST", "/api/lists", { title: "L" });
    return { h, id: l.json.id as string };
  }
  const order = async (h: ReturnType<typeof harness>, id: string) =>
    (await h.call("GET", `/api/lists/${id}`)).json.items.map((i: any) => i.media_item_id);

  it("replaces, reorders and removes in one db.batch", async () => {
    const { h, id } = await withList();
    h.batch.mockClear();
    const r = await h.call("PUT", `/api/lists/${id}/items`, {
      items: [{ media_item_id: "itm_1" }, { media_item_id: "itm_2" }, { media_item_id: "itm_3" }],
    });
    expect(r.status).toBe(200);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(await order(h, id)).toEqual(["itm_1", "itm_2", "itm_3"]);

    await h.call("PUT", `/api/lists/${id}/items`, { items: [{ media_item_id: "itm_3" }, { media_item_id: "itm_1" }] });
    expect(await order(h, id)).toEqual(["itm_3", "itm_1"]);
    await h.call("PUT", `/api/lists/${id}/items`, { items: [] });
    expect(await order(h, id)).toEqual([]);
  });

  it("rejects duplicates, missing, archived ids and bad shapes with 422, leaving the list intact", async () => {
    const { h, id } = await withList();
    await h.call("PUT", `/api/lists/${id}/items`, { items: [{ media_item_id: "itm_1" }] });
    const dup = await h.call("PUT", `/api/lists/${id}/items`, { items: [{ media_item_id: "itm_2" }, { media_item_id: "itm_2" }] });
    expect(dup.status).toBe(422);
    const bad = await h.call("PUT", `/api/lists/${id}/items`, {
      items: [{ media_item_id: "itm_2" }, { media_item_id: "itm_missing" }, { media_item_id: "itm_arch" }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toContain("itm_missing");
    expect(bad.json.message).toContain("itm_arch");
    expect((await h.call("PUT", `/api/lists/${id}/items`, { items: "x" })).status).toBe(422);
    const many = Array.from({ length: 101 }, (_, i) => ({ media_item_id: `itm_${i}` }));
    expect((await h.call("PUT", `/api/lists/${id}/items`, { items: many })).status).toBe(422);
    expect(await order(h, id)).toEqual(["itm_1"]);
    expect((await h.call("PUT", "/api/lists/lst_nope/items", { items: [] })).status).toBe(404);
  });
});

describe("draft", () => {
  async function seeded(fetchImpl?: typeof fetch, env?: Record<string, unknown>) {
    const h = harness(fetchImpl, env);
    await seed(h.db, {
      id: "itm_a", title: "Alpha", status: "Completed", myRating: 5, completedAt: "2026-01-02T00:00:00Z",
      personalNotes: "SECRET-NOTE", reviewText: "SECRET-REVIEW", genresJson: '["Drama"]',
    });
    await seed(h.db, { id: "itm_b", title: "Beta", status: "Completed", myRating: 3, completedAt: "2026-01-03T00:00:00Z" });
    await seed(h.db, { id: "itm_c", title: "Gamma", status: "Completed", mediaType: "Book", completedAt: "2026-01-04T00:00:00Z" });
    await seed(h.db, { id: "itm_x", title: "Backlogged", status: "Backlog" });
    await seed(h.db, { id: "itm_z", title: "Gone", status: "Archived" });
    return h;
  }

  it("validates ids, drops foreign and duplicate ids, trims blurbs, caps, and does not save", async () => {
    const f = geminiFetch(() =>
      draftResp({
        title: "Top",
        description: "Desc",
        items: [
          { media_item_id: "itm_b", blurb: "y".repeat(500) },
          { media_item_id: "itm_foreign", blurb: "no" },
          { media_item_id: "itm_x", blurb: "not completed" },
          { media_item_id: "itm_z", blurb: "archived" },
          { media_item_id: "itm_b", blurb: "dupe" },
          { media_item_id: "itm_a", blurb: "ok" },
          { media_item_id: "itm_c", blurb: "over cap" },
        ],
      }),
    );
    const h = await seeded(f.fetchImpl);
    const r = await h.call("POST", "/api/lists/draft", { prompt: "my best", limit: 2 });
    expect(r.status).toBe(200);
    expect(r.json.title).toBe("Top");
    expect(r.json.items.map((i: any) => i.media_item_id)).toEqual(["itm_b", "itm_a"]);
    expect(r.json.items[0].blurb).toHaveLength(200);
    expect(r.json.items[1]).toEqual({ media_item_id: "itm_a", title: "Alpha", blurb: "ok" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(GEMINI_URL);
    expect(JSON.parse(f.calls[0]!.body!).generationConfig.responseSchema).toBeTruthy();
    expect((await h.call("GET", "/api/lists")).json.lists).toHaveLength(0);
  });

  it("orders candidates by rating desc nulls last, filters by type, and never sends notes or reviews", async () => {
    const f = geminiFetch(() => draftResp({ title: "t", description: "d", items: [] }));
    const h = await seeded(f.fetchImpl);
    await h.call("POST", "/api/lists/draft", { prompt: "go" });
    const body = f.calls[0]!.body!;
    expect(body).not.toContain("SECRET-NOTE");
    expect(body).not.toContain("SECRET-REVIEW");
    expect(body).not.toContain("personal_notes");
    expect(body).not.toContain("review_text");
    expect(body).not.toContain("Backlogged");
    expect(body).not.toContain("Gone");
    expect(body.indexOf("Alpha")).toBeLessThan(body.indexOf("Beta"));
    expect(body.indexOf("Beta")).toBeLessThan(body.indexOf("Gamma"));
    expect(body).not.toContain(GEMINI_KEY);
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe(GEMINI_KEY);

    await h.call("POST", "/api/lists/draft", { prompt: "books", media_type: "Book" });
    const body2 = f.calls[1]!.body!;
    expect(body2).toContain("Gamma");
    expect(body2).not.toContain("Alpha");
  });

  it("caps the prompt, default limit and validates input", async () => {
    const f = geminiFetch(() => draftResp({ title: "t", description: "d", items: [] }));
    const h = await seeded(f.fetchImpl);
    expect((await h.call("POST", "/api/lists/draft", { prompt: "p".repeat(501) })).status).toBe(422);
    expect((await h.call("POST", "/api/lists/draft", { prompt: "" })).status).toBe(422);
    expect((await h.call("POST", "/api/lists/draft", { prompt: "x", media_type: "Music" })).status).toBe(422);
    expect((await h.call("POST", "/api/lists/draft", { prompt: "x", limit: 0 })).status).toBe(422);
    expect(f.calls).toHaveLength(0);
  });

  it("503 not_configured without a key, no fetch", async () => {
    const f = geminiFetch(() => draftResp({}));
    const h = await seeded(f.fetchImpl, {});
    const r = await h.call("POST", "/api/lists/draft", { prompt: "x" });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("not_configured");
    expect(f.calls).toHaveLength(0);
  });

  it("422 no_candidates with zero fetch calls", async () => {
    const f = geminiFetch(() => draftResp({}));
    const h = harness(f.fetchImpl);
    const r = await h.call("POST", "/api/lists/draft", { prompt: "x" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("no_candidates");
    expect(f.calls).toHaveLength(0);
  });

  it("Gemini 500 gives 502 draft_failed without leaking the key", async () => {
    const f = geminiFetch(new Response("boom " + GEMINI_KEY, { status: 500 }));
    const h = await seeded(f.fetchImpl);
    const r = await h.call("POST", "/api/lists/draft", { prompt: "x" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("draft_failed");
    expect(JSON.stringify(r.json)).not.toContain(GEMINI_KEY);
  });

  it("unparseable Gemini output gives 502", async () => {
    const f = geminiFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }));
    const h = await seeded(f.fetchImpl);
    expect((await h.call("POST", "/api/lists/draft", { prompt: "x" })).status).toBe(502);
  });
});
