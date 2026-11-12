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
    for (const s of ["Active", "Paused", "Up Next", "Pending Review", "Sweep Inbox Now", 'data-action="backup"', "/library/movie", "Completed Archive"]) {
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
