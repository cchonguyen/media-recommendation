import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { app } from "../index";
import {
  activityLog,
  curatedListItems,
  curatedLists,
  intakeLog,
  mediaItems,
  systemKv,
} from "./schema";

const col = (table: Parameters<typeof getTableConfig>[0], name: string) => {
  const c = getTableConfig(table).columns.find((x) => x.name === name);
  if (!c) throw new Error(`missing column ${name}`);
  return c;
};

describe("tables", () => {
  it("defines all six tables", () => {
    expect(
      [mediaItems, activityLog, intakeLog, systemKv, curatedLists, curatedListItems]
        .map((t) => getTableConfig(t).name)
        .sort(),
    ).toEqual(
      ["activity_log", "curated_list_items", "curated_lists", "intake_log", "media_items", "system_kv"],
    );
  });
});

describe("media_items", () => {
  const expected = [
    "id", "title", "raw_input", "year_hint", "media_type", "status", "enrichment_status",
    "enrichment_attempts", "enrichment_error", "tmdb_id", "imdb_id", "igdb_id", "isbn13",
    "itunes_id", "source_url", "recommender_name", "recommender_count", "trust_weight",
    "personal_notes", "my_rating", "personal_tier", "review_text", "review_done",
    "consumed_year", "completed_at", "creator", "release_year", "release_date",
    "release_state", "release_access_display", "streaming_providers_json", "genres_json",
    "is_available_now", "critic_score", "critic_score_display", "time_commitment_display",
    "time_commitment_minutes", "amazon_link", "poster_image_url", "alternative_matches_note",
    "category_metadata_json", "priority_score", "last_status_change_at", "last_enriched_at",
    "created_at", "updated_at",
  ];

  it("has every spec column", () => {
    expect(getTableConfig(mediaItems).columns.map((c) => c.name).sort()).toEqual([...expected].sort());
  });

  it("has the stated defaults", () => {
    expect(col(mediaItems, "status").default).toBe("Backlog");
    expect(col(mediaItems, "enrichment_status").default).toBe("PENDING");
    expect(col(mediaItems, "enrichment_attempts").default).toBe(0);
    expect(col(mediaItems, "recommender_name").default).toBe("Self");
    expect(col(mediaItems, "recommender_count").default).toBe(1);
    expect(col(mediaItems, "trust_weight").default).toBe(3);
    expect(col(mediaItems, "personal_notes").default).toBe("");
    expect(col(mediaItems, "review_done").default).toBe(false);
    expect(col(mediaItems, "release_state").default).toBe("Unknown");
    expect(col(mediaItems, "release_access_display").default).toBe("Unknown");
    expect(col(mediaItems, "streaming_providers_json").default).toBe("[]");
    expect(col(mediaItems, "genres_json").default).toBe("[]");
    expect(col(mediaItems, "is_available_now").default).toBe(false);
    expect(col(mediaItems, "category_metadata_json").default).toBe("{}");
    expect(col(mediaItems, "priority_score").default).toBe(51);
  });

  it("has the stated enums", () => {
    expect(col(mediaItems, "media_type").enumValues).toEqual(
      ["Movie", "TV", "Book", "Game", "Podcast", "One-Off"],
    );
    expect(col(mediaItems, "status").enumValues).toEqual(
      ["Backlog", "Up Next", "Active", "Paused", "Completed", "Abandoned", "Archived"],
    );
    expect(col(mediaItems, "enrichment_status").enumValues).toEqual(
      ["PENDING", "ENRICHED", "FAILED", "SKIPPED"],
    );
    expect(col(mediaItems, "personal_tier").enumValues).toEqual(["S", "A", "B", "C", "D"]);
    expect(col(mediaItems, "release_state").enumValues).toContain("In_Theaters_Limited");
  });

  it("has the six indexes", () => {
    const idx = getTableConfig(mediaItems).indexes.map((i) => i.config.columns.map((c) => (c as { name: string }).name));
    expect(idx.flat().sort()).toEqual(
      ["consumed_year", "enrichment_status", "media_type", "priority_score", "release_year", "status"],
    );
  });

  it("marks required columns not null", () => {
    for (const n of ["title", "raw_input", "media_type", "last_status_change_at", "created_at", "updated_at"]) {
      expect(col(mediaItems, n).notNull).toBe(true);
    }
    expect(col(mediaItems, "year_hint").notNull).toBe(false);
  });
});

describe("activity_log", () => {
  it("item_id FK sets null on delete", () => {
    const fks = getTableConfig(activityLog).foreignKeys;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.onDelete).toBe("set null");
  });
  it("event enum includes merge events", () => {
    const e = col(activityLog, "event_type").enumValues;
    expect(e).toContain("MERGED_RECOMMENDATION");
    expect(e).toContain("CANONICAL_MERGE");
  });
  it("indexes item_id and created_at", () => {
    const idx = getTableConfig(activityLog).indexes.flatMap((i) => i.config.columns.map((c) => (c as { name: string }).name));
    expect(idx.sort()).toEqual(["created_at", "item_id"]);
  });
});

describe("intake_log and system_kv", () => {
  it("intake_log primary key is line_hash", () => {
    expect(col(intakeLog, "line_hash").primary).toBe(true);
    expect(col(intakeLog, "source").enumValues).toEqual(["gdoc", "webhook"]);
  });
  it("system_kv has key, value, expires_at", () => {
    expect(getTableConfig(systemKv).columns.map((c) => c.name).sort()).toEqual(["expires_at", "key", "value"]);
    expect(col(systemKv, "key").primary).toBe(true);
  });
});

describe("curated tables", () => {
  it("curated_lists has a unique slug index", () => {
    const idx = getTableConfig(curatedLists).indexes.find((i) => i.config.unique);
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(["slug"]);
  });
  it("curated_list_items FKs cascade", () => {
    const fks = getTableConfig(curatedListItems).foreignKeys;
    expect(fks).toHaveLength(2);
    for (const fk of fks) expect(fk.onDelete).toBe("cascade");
  });
  it("curated_list_items indexes (list_id, rank)", () => {
    const idx = getTableConfig(curatedListItems).indexes[0]!;
    expect(idx.config.columns.map((c) => (c as { name: string }).name)).toEqual(["list_id", "rank"]);
  });
});

describe("generated migration", () => {
  it("applies and round-trips one row per table", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const dir = join(__dirname, "..", "..", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) {
        if (stmt.trim()) db.exec(stmt);
      }
    }
    const now = "2026-11-11T00:00:00.000Z";
    db.prepare(
      "INSERT INTO media_items (id, title, raw_input, media_type, last_status_change_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run("itm_00000001", "Dune", "dune", "Movie", now, now, now);
    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get("itm_00000001") as Record<string, unknown>;
    expect(row.status).toBe("Backlog");
    expect(row.enrichment_status).toBe("PENDING");
    expect(row.enrichment_attempts).toBe(0);
    expect(row.recommender_name).toBe("Self");
    expect(row.recommender_count).toBe(1);
    expect(row.trust_weight).toBe(3);
    expect(row.review_done).toBe(0);
    expect(row.priority_score).toBe(51);
    expect(row.streaming_providers_json).toBe("[]");
    expect(row.category_metadata_json).toBe("{}");
    expect(row.release_state).toBe("Unknown");

    db.prepare("INSERT INTO activity_log (item_id, item_title_snapshot, media_type, event_type, day_of_week_pt, hour_of_day_pt, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("itm_00000001", "Dune", "Movie", "CREATED", 3, 12, now);
    db.prepare("INSERT INTO intake_log (line_hash, raw_line, source, created_at) VALUES (?,?,?,?)").run("abc", "Dune", "gdoc", now);
    db.prepare("INSERT INTO system_kv (key, value, expires_at) VALUES (?,?,?)").run("k", "v", 123);
    db.prepare("INSERT INTO curated_lists (id, slug, title, created_at, updated_at) VALUES (?,?,?,?,?)").run("lst_000001", "best", "Best", now, now);
    db.prepare("INSERT INTO curated_list_items (id, list_id, media_item_id, rank, created_at) VALUES (?,?,?,?,?)").run("cli_1", "lst_000001", "itm_00000001", 1, now);

    expect((db.prepare("SELECT count(*) c FROM activity_log").get() as { c: number }).c).toBe(1);
    expect(db.prepare("SELECT value FROM system_kv WHERE key='k'").get()).toEqual({ value: "v" });
    expect((db.prepare("SELECT blurb FROM curated_list_items").get() as { blurb: string }).blurb).toBe("");
    expect(() => db.prepare("INSERT INTO curated_lists (id, slug, title, created_at, updated_at) VALUES (?,?,?,?,?)").run("lst_2", "best", "x", now, now)).toThrow();

    db.prepare("DELETE FROM media_items WHERE id = ?").run("itm_00000001");
    expect((db.prepare("SELECT item_id FROM activity_log").get() as { item_id: unknown }).item_id).toBeNull();
    expect((db.prepare("SELECT count(*) c FROM curated_list_items").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe("GET /health", () => {
  it("returns 200 {ok:true}", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
