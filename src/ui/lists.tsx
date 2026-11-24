import { Hono } from "hono";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { MEDIA_TYPES, curatedListItems, curatedLists, mediaItems } from "../db/schema";
import { Field, IconMenu, MEDIA_TYPE_ICON } from "./controls";
import { Icon } from "./icons";
import { Layout, loadStatusStrip } from "./layout";

const LIMIT = 100;

function TypeSelect(props: { id: string; name: string; selected?: string | null; blank: string }) {
  return (
    <Field id={props.id} label="Media type">
      <IconMenu
        id={props.id}
        name={props.name}
        value={props.selected ?? ""}
        label="Media type"
        options={[
          { value: "", label: props.blank, icon: "layers" },
          ...MEDIA_TYPES.map((t) => ({ value: t, label: t, icon: MEDIA_TYPE_ICON[t] ?? "film" })),
        ]}
      />
    </Field>
  );
}

/** One list item row. Used by the template and by the server-rendered editor, so both match. */
function ItemRow(props: { mediaId?: string; rank?: number; title?: string; blurb?: string | null }) {
  return (
    <li class="ui-card app-row" data-media-id={props.mediaId ?? ""}>
      <span class="rank ui-pill ui-pill--mid ui-data app-rank">{props.rank ?? ""}</span>
      <span class="t app-row__title">{props.title ?? ""}</span>
      <textarea class="ui-textarea app-blurb" rows={1} maxlength={200} placeholder="Blurb (optional)" aria-label="Blurb">
        {props.blurb ?? ""}
      </textarea>
      <div class="app-actions">
        <button type="button" class="ui-icon-btn" data-action="row-up" aria-label="Move up" title="Move up">
          <Icon name="arrow-up" />
        </button>
        <button type="button" class="ui-icon-btn" data-action="row-down" aria-label="Move down" title="Move down">
          <Icon name="arrow-down" />
        </button>
        <button type="button" class="ui-icon-btn" data-action="row-remove" aria-label="Remove from list" title="Remove from list">
          <Icon name="x" />
        </button>
      </div>
    </li>
  );
}

/** Cloned by the client script for every list item row. Holds no data. */
function ItemTemplate() {
  return (
    <template id="item-tpl">
      <ItemRow />
    </template>
  );
}

function PublicSwitch(props: { id: string; isPublic: boolean }) {
  return (
    <label class="ui-switch">
      <input type="checkbox" role="switch" data-action="list-public" data-id={props.id} data-public={props.isPublic ? "true" : "false"} checked={props.isPublic} />
      Public
      <span class="ui-switch__state">{props.isPublic ? "On" : "Off"}</span>
    </label>
  );
}

function ShareLine(props: { slug: string }) {
  return (
    <span class="app-share">
      <span class="ui-data" data-share-slug={props.slug} />
      <button type="button" class="ui-btn" data-action="copy-share" data-slug={props.slug}>
        <Icon name="copy" />
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
      <Layout active="lists" status={status} title="Lists" heading="Lists">
        <section class="app-section" aria-labelledby="h-lists">
          <h2 class="ui-display app-h2" id="h-lists">
            Your lists
          </h2>
          {lists.length === 0 ? (
            <p class="app-empty ui-missing">No lists yet. Create one below or draft one with AI.</p>
          ) : (
            <div class="app-list">
              {lists.map((l) => (
                <div class="ui-card app-row">
                  <div class="app-row__title">
                    <a href={`/lists/${l.id}`}>{l.title}</a>
                  </div>
                  <span class="ui-data ui-muted">{Number(l.itemCount)} items</span>
                  <PublicSwitch id={l.id} isPublic={l.isPublic} />
                  {l.isPublic ? <ShareLine slug={l.slug} /> : null}
                  <div class="app-actions">
                    <a class="ui-btn" href={`/lists/${l.id}`}>
                      Edit
                    </a>
                    <button type="button" class="ui-btn ui-btn--danger" data-action="list-delete" data-id={l.id}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section class="app-section" aria-labelledby="h-create">
          <h2 class="ui-display app-h2" id="h-create">
            Create List
          </h2>
          <form class="app-form" data-action="list-create">
            <Field id="create-title" label="Title">
              <input class="ui-input" id="create-title" type="text" name="title" required maxlength={300} />
            </Field>
            <Field id="create-desc" label="Description">
              <input class="ui-input" id="create-desc" type="text" name="description" maxlength={2000} />
            </Field>
            <TypeSelect id="list-type" name="media_type" blank="Any media type" />
            <button type="submit" class="ui-btn ui-btn--primary">
              <Icon name="plus" />
              Create List
            </button>
          </form>
        </section>

        <section class="app-section" aria-labelledby="h-draft">
          <h2 class="ui-display app-h2" id="h-draft">
            Draft List with AI
          </h2>
          <form class="app-stack" data-action="draft">
            <Field id="draft-prompt" label="Prompt">
              <textarea class="ui-textarea" id="draft-prompt" name="prompt" required rows={3} maxlength={1000} placeholder="e.g. My best sci-fi movies" />
            </Field>
            <TypeSelect id="draft-type" name="media_type" blank="Any media type" />
            <div class="app-actions">
              <button type="submit" class="ui-btn">
                Generate
              </button>
            </div>
          </form>
        </section>

        <section class="app-section" id="draft-panel" aria-labelledby="h-draft-panel" hidden>
          <h2 class="ui-display app-h2" id="h-draft-panel">
            Draft
          </h2>
          <div class="app-stack">
            <Field id="draft-title" label="Draft title">
              <input class="ui-input" id="draft-title" type="text" maxlength={300} />
            </Field>
            <Field id="draft-desc" label="Draft description">
              <textarea class="ui-textarea" id="draft-desc" rows={2} maxlength={2000} />
            </Field>
            <input type="hidden" id="draft-filter" />
          </div>
          <p class="app-empty ui-missing" data-empty hidden>
            No items in the draft.
          </p>
          <ol id="draft-items" class="app-list" />
          <div class="app-actions">
            <button type="button" class="ui-btn" data-action="draft-save">
              Save draft as list
            </button>
          </div>
        </section>
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
        <Layout active="lists" status={status} title="List not found" heading="List not found">
          <p>
            <a class="ui-btn ui-btn--ghost" href="/lists">
              Back to Lists
            </a>
          </p>
        </Layout>,
        404,
      );
    }
    const items = rows.filter((r) => r.mediaId !== null);
    return c.html(
      <Layout active="lists" status={status} title={list.title} heading="Edit list">
        <p>
          <a class="ui-btn ui-btn--ghost" href="/lists">
            Back to Lists
          </a>
        </p>
        <form class="app-stack" data-action="list-meta" data-id={id}>
          <Field id="meta-title" label="Title">
            <input class="ui-input" id="meta-title" type="text" name="title" required maxlength={300} value={list.title} />
          </Field>
          <Field id="meta-desc" label="Description">
            <textarea class="ui-textarea" id="meta-desc" name="description" rows={2} maxlength={2000}>
              {list.description}
            </textarea>
          </Field>
          <TypeSelect id="meta-type" name="media_type" selected={list.filter} blank="Any media type" />
          <div class="app-actions">
            <button type="submit" class="ui-btn">
              Save details
            </button>
          </div>
        </form>

        <section class="app-section" aria-labelledby="h-share">
          <h2 class="ui-display app-h2" id="h-share">
            Sharing
          </h2>
          <div class="ui-card app-row">
            <PublicSwitch id={id} isPublic={list.isPublic} />
            {list.isPublic ? <ShareLine slug={list.slug} /> : <span class="ui-muted">Private. Turn on to get a share link.</span>}
          </div>
        </section>

        <section class="app-section" aria-labelledby="h-items">
          <h2 class="ui-display app-h2" id="h-items">
            Items
          </h2>
          <p class="app-empty ui-missing" data-empty hidden={items.length > 0}>
            No items yet. Add some below.
          </p>
          <ol id="list-items" class="app-list">
            {items.map((r, n) => (
              <ItemRow mediaId={r.mediaId ?? ""} rank={n + 1} title={r.itemTitle ?? ""} blurb={r.blurb} />
            ))}
          </ol>
          <div class="app-actions">
            <button type="button" class="ui-btn ui-btn--primary" data-action="list-save" data-id={id}>
              Save
            </button>
            <button type="button" class="ui-btn ui-btn--danger" data-action="list-delete" data-id={id}>
              Delete list
            </button>
          </div>
        </section>

        <section class="app-section" aria-labelledby="h-add">
          <h2 class="ui-display app-h2" id="h-add">
            Add items
          </h2>
          <form class="app-form" data-action="pick">
            <Field id="pick-q" label="Search your library">
              <input class="ui-input" id="pick-q" type="text" name="q" maxlength={200} />
            </Field>
            <button type="submit" class="ui-btn">
              <Icon name="search" />
              Search
            </button>
          </form>
          <div id="pick-results" class="app-actions" />
        </section>
        <ItemTemplate />
      </Layout>,
    );
  });

  return ui;
}
