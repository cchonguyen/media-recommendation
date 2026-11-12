import { Hono } from "hono";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, curatedListItems, curatedLists, mediaItems } from "../db/schema";
import { Layout, loadStatusStrip } from "./layout";

const LIMIT = 100;

function TypeSelect(props: { name: string; id?: string; selected?: string | null; blank: string }) {
  return (
    <select name={props.name} id={props.id} aria-label="Media type">
      <option value="">{props.blank}</option>
      {MEDIA_TYPES.map((t) => (
        <option value={t} selected={t === props.selected}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** Cloned by the client script for every list item row. Holds no data. */
function ItemTemplate() {
  return (
    <template id="item-tpl">
      <li class="row" data-media-id="">
        <span class="rank pill" />
        <span class="t" />
        <textarea rows={1} maxlength={200} placeholder="Blurb (optional)" aria-label="Blurb" style="flex:2;min-width:12rem" />
        <div class="actions">
          <button type="button" data-action="row-up" aria-label="Move up">
            Up
          </button>
          <button type="button" data-action="row-down" aria-label="Move down">
            Down
          </button>
          <button type="button" data-action="row-remove">
            Remove
          </button>
        </div>
      </li>
    </template>
  );
}

function ShareLine(props: { slug: string }) {
  return (
    <span class="meta">
      <span data-share-slug={props.slug} />{" "}
      <button type="button" data-action="copy-share" data-slug={props.slug}>
        Copy
      </button>
    </span>
  );
}

export function createListsUiRoutes(options: { now?: () => Date } = {}) {
  const nowFn = options.now ?? (() => new Date());
  const ui = new Hono<{ Bindings: { DB: D1Database } }>();

  ui.get("/lists", async (c) => {
    const db = drizzle(c.env.DB);
    const [status, lists] = await Promise.all([
      loadStatusStrip(c.env.DB, nowFn()),
      db
        .select({
          id: curatedLists.id,
          slug: curatedLists.slug,
          title: curatedLists.title,
          isPublic: curatedLists.isPublic,
          itemCount: sql<number>`count(${curatedListItems.id})`,
        })
        .from(curatedLists)
        .leftJoin(curatedListItems, eq(curatedListItems.listId, curatedLists.id))
        .groupBy(curatedLists.id)
        .orderBy(desc(curatedLists.createdAt), desc(curatedLists.id))
        .limit(LIMIT),
    ]);
    return c.html(
      <Layout active="lists" status={status} title="Lists">
        <h1>Lists</h1>

        {lists.length === 0 ? (
          <p class="empty">No lists yet. Create one below or draft one with AI.</p>
        ) : (
          <div class="list">
            {lists.map((l) => (
              <div class="row">
                <div class="t">
                  <a href={`/lists/${l.id}`}>{l.title}</a>
                </div>
                <span class="meta">{Number(l.itemCount)} items</span>
                <button type="button" data-action="list-public" data-id={l.id} data-public={l.isPublic ? "true" : "false"}>
                  {l.isPublic ? "Public: on" : "Public: off"}
                </button>
                {l.isPublic ? <ShareLine slug={l.slug} /> : null}
                <div class="actions">
                  <a href={`/lists/${l.id}`}>Edit</a>
                  <button type="button" data-action="list-delete" data-id={l.id}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <h2>Create List</h2>
        <form class="inline" data-action="list-create">
          <input type="text" name="title" required maxlength={300} placeholder="Title" aria-label="Title" />
          <input type="text" name="description" maxlength={2000} placeholder="Description" aria-label="Description" />
          <TypeSelect name="media_type" blank="Any media type" />
          <button type="submit" class="primary">
            Create List
          </button>
        </form>

        <h2>Draft List with AI</h2>
        <form class="rate" data-action="draft">
          <textarea name="prompt" required rows={3} maxlength={1000} placeholder="e.g. My best sci-fi movies" aria-label="Prompt" />
          <div class="actions">
            <TypeSelect name="media_type" blank="Any media type" />
            <button type="submit" class="primary">
              Generate
            </button>
          </div>
        </form>
        <div id="draft-panel" hidden>
          <h2>Draft</h2>
          <div class="rate" style="display:flex;flex-direction:column;gap:.4rem">
            <input type="text" id="draft-title" maxlength={300} aria-label="Draft title" />
            <textarea id="draft-desc" rows={2} maxlength={2000} aria-label="Draft description" />
            <input type="hidden" id="draft-filter" />
          </div>
          <p class="empty" data-empty hidden>
            No items in the draft.
          </p>
          <ol id="draft-items" class="list" style="padding:0;list-style:none;margin:.6rem 0" />
          <button type="button" class="primary" data-action="draft-save">
            Save draft as list
          </button>
        </div>
        <ItemTemplate />
      </Layout>,
    );
  });

  ui.get("/lists/:id", async (c) => {
    const id = c.req.param("id");
    const db = drizzle(c.env.DB);
    // One joined read for the list and its items. Archived items are left out.
    const [status, rows] = await Promise.all([
      loadStatusStrip(c.env.DB, nowFn()),
      db
        .select({
          title: curatedLists.title,
          description: curatedLists.description,
          slug: curatedLists.slug,
          filter: curatedLists.mediaTypeFilter,
          isPublic: curatedLists.isPublic,
          mediaId: mediaItems.id,
          itemTitle: mediaItems.title,
          blurb: curatedListItems.blurb,
        })
        .from(curatedLists)
        .leftJoin(curatedListItems, eq(curatedListItems.listId, curatedLists.id))
        .leftJoin(mediaItems, and(eq(mediaItems.id, curatedListItems.mediaItemId), ne(mediaItems.status, "Archived")))
        .where(eq(curatedLists.id, id))
        .orderBy(asc(curatedListItems.rank))
        .limit(LIMIT),
    ]);
    const list = rows[0];
    if (!list) {
      return c.html(
        <Layout active="lists" status={status} title="List not found">
          <h1>List not found</h1>
          <p>
            <a href="/lists">Back to Lists</a>
          </p>
        </Layout>,
        404,
      );
    }
    const items = rows.filter((r) => r.mediaId !== null);
    return c.html(
      <Layout active="lists" status={status} title={list.title}>
        <p>
          <a href="/lists">Back to Lists</a>
        </p>
        <h1>Edit list</h1>
        <form class="rate" data-action="list-meta" data-id={id}>
          <input type="text" name="title" required maxlength={300} value={list.title} aria-label="Title" />
          <textarea name="description" rows={2} maxlength={2000} aria-label="Description">
            {list.description}
          </textarea>
          <div class="actions">
            <TypeSelect name="media_type" selected={list.filter} blank="Any media type" />
            <button type="submit" class="primary">
              Save details
            </button>
          </div>
        </form>

        <h2>Sharing</h2>
        <div class="row">
          <button type="button" data-action="list-public" data-id={id} data-public={list.isPublic ? "true" : "false"}>
            {list.isPublic ? "Public: on" : "Public: off"}
          </button>
          {list.isPublic ? <ShareLine slug={list.slug} /> : <span class="meta">Private. Turn on to get a share link.</span>}
        </div>

        <h2>Items</h2>
        <p class="empty" data-empty hidden={items.length > 0}>
          No items yet. Add some below.
        </p>
        <ol id="list-items" class="list" style="padding:0;list-style:none;margin:.6rem 0">
          {items.map((r, n) => (
            <li class="row" data-media-id={r.mediaId ?? ""}>
              <span class="rank pill">{n + 1}</span>
              <span class="t">{r.itemTitle}</span>
              <textarea rows={1} maxlength={200} placeholder="Blurb (optional)" aria-label="Blurb" style="flex:2;min-width:12rem">
                {r.blurb ?? ""}
              </textarea>
              <div class="actions">
                <button type="button" data-action="row-up" aria-label="Move up">
                  Up
                </button>
                <button type="button" data-action="row-down" aria-label="Move down">
                  Down
                </button>
                <button type="button" data-action="row-remove">
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
        <div class="actions">
          <button type="button" class="primary" data-action="list-save" data-id={id}>
            Save
          </button>
          <button type="button" data-action="list-delete" data-id={id}>
            Delete list
          </button>
        </div>

        <h2>Add items</h2>
        <form class="inline" data-action="pick">
          <input type="text" name="q" maxlength={200} placeholder="Search your library" aria-label="Search your library" />
          <button type="submit">Search</button>
        </form>
        <div id="pick-results" class="actions" />
        <ItemTemplate />
      </Layout>,
    );
  });

  return ui;
}
