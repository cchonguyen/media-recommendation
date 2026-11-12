// Static client script, injected inline. Never interpolates row data.
export const CLIENT_SCRIPT = `
(function () {
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(function () { t.hidden = true; }, 9000);
  }
  function call(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.message || j.error || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }
  function done(p, btn) {
    if (btn) btn.disabled = true;
    return p.then(function () { location.reload(); }, function (e) {
      if (btn) btn.disabled = false;
      toast(e.message);
    });
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!el || el.tagName === "FORM") return;
    var a = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    if (a === "status") {
      done(call("POST", "/api/items/" + encodeURIComponent(id) + "/status", { status: el.getAttribute("data-status") }), el);
    } else if (a === "toggle-rate") {
      var f = document.getElementById("rate-" + id);
      if (f) f.hidden = !f.hidden;
    } else if (a === "sweep") {
      if (el.disabled) return;
      el.disabled = true;
      toast("Sweeping the inbox...");
      call("POST", "/api/sweep").then(function (r) {
        var msg;
        var reload = false;
        if (r.skipped === "no-inbox-doc") { msg = "Inbox is not configured: add the INBOX_DOC_ID secret."; }
        else if (r.skipped === "nothing-to-do") { msg = "The inbox is empty. Add a line under the header in the Doc first."; }
        else if (r.ingest) {
          var g = r.ingest;
          msg = g.created + " new, " + g.merged + " merged, " + g.skippedDuplicates + " already seen";
          if (g.unparsedLines && g.unparsedLines.length) msg += ", " + g.unparsedLines.length + " could not be read and were left in the Doc";
          if (r.cleared === false) msg += ". The Doc could not be cleared; it will retry in 15 minutes.";
          reload = true;
        } else { msg = "Sweep finished."; }
        el.disabled = false;
        toast(msg);
        if (reload) setTimeout(function () { location.reload(); }, 3500);
      }, function (e) {
        el.disabled = false;
        toast(/Gemini|parser/i.test(e.message) ? e.message + " Your lines are safe in the Doc; try again in a minute." : e.message);
      });
    } else if (a === "backup") {
      if (el.disabled) return;
      el.disabled = true;
      call("POST", "/api/backup").then(function (r) {
        el.disabled = false;
        var n = r.rows || {};
        var t = r.truncated || {};
        var capped = [];
        if (t.library) capped.push("Library_Archive");
        if (t.active) capped.push("Active_Queue");
        if (t.lists) capped.push("Curated_Lists");
        var msg = "Backup done: " + n.library + " archive, " + n.active + " queue, " + n.lists + " list rows.";
        if (capped.length) msg += " Capped at 500 rows: " + capped.join(", ") + ".";
        toast(msg);
        var lb = document.getElementById("last-backup");
        if (lb && r.lastBackupAt) lb.textContent = "Last backup: " + r.lastBackupAt.replace("T", " ").slice(0, 16) + " UTC";
      }, function (e) { el.disabled = false; toast(e.message); });
    } else if (a === "archive") {
      if (!window.confirm("Archive this item? It will be hidden from the library.")) return;
      done(call("DELETE", "/api/items/" + encodeURIComponent(id)), el);
    }
  });
  function cellDone(p, el) {
    el.disabled = true;
    p.then(function () { el.disabled = false; toast("Saved"); }, function (e) {
      el.disabled = false;
      toast(e.message);
      setTimeout(function () { location.reload(); }, 1500);
    });
  }
  function itemUrl(id) { return "/api/items/" + encodeURIComponent(id); }
  document.addEventListener("change", function (ev) {
    var el = ev.target;
    var a = el.getAttribute && el.getAttribute("data-action");
    if (!a) return;
    var id = el.getAttribute("data-id");
    if (a === "set-status") {
      done(call("POST", itemUrl(id) + "/status", { status: el.value }), el);
    } else if (a === "set-type") {
      done(call("PATCH", itemUrl(id), { media_type: el.value }), el);
    } else if (a === "title") {
      var t = el.value.trim();
      if (!t) { toast("Title must not be empty."); location.reload(); return; }
      cellDone(call("PATCH", itemUrl(id), { title: t }), el);
    } else if (a === "notes") {
      cellDone(call("PATCH", itemUrl(id), { personal_notes: el.value }), el);
    } else if (a === "rating" || a === "tier") {
      var cell = el.closest(".rating-cell");
      var r = cell.querySelector("[data-action=rating]").value;
      var tr = cell.querySelector("[data-action=tier]").value;
      if (!r) { toast("Pick a rating first."); return; }
      var body = { rating: Number(r) };
      if (tr) body.tier = tr;
      cellDone(call("POST", itemUrl(id) + "/rating", body), el);
    }
  });
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var a = form.getAttribute && form.getAttribute("data-action");
    if (!a) return;
    ev.preventDefault();
    var btn = form.querySelector("button[type=submit]");
    var fd = new FormData(form);
    var id = form.getAttribute("data-id");
    if (a === "rate" || a === "complete") {
      var body = { rating: Number(fd.get("rating")) };
      var tier = fd.get("tier");
      if (tier) body.tier = String(tier);
      body.review_text = String(fd.get("review_text") || "");
      var base = "/api/items/" + encodeURIComponent(id);
      var p = a === "complete"
        ? call("POST", base + "/status", { status: "Completed" }).then(function () { return call("POST", base + "/rating", body); })
        : call("POST", base + "/rating", body);
      done(p, btn);
    } else if (a === "add") {
      done(call("POST", "/api/items", { title: String(fd.get("title") || ""), media_type: String(fd.get("media_type")) }), btn);
    }
  });
  // ---- Lists (Slice 10). Row data is only ever set with textContent/value/setAttribute. ----
  var MAX_ITEMS = 100;
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function shareUrl(slug) { return window.location.origin + "/share/" + slug; }
  Array.prototype.forEach.call(document.querySelectorAll("[data-share-slug]"), function (n) {
    n.textContent = shareUrl(n.getAttribute("data-share-slug"));
  });
  function addItemRow(container, mediaId, title, blurb) {
    var tpl = document.getElementById("item-tpl");
    if (!tpl || !container) return false;
    var rows = container.querySelectorAll("[data-media-id]");
    if (rows.length >= MAX_ITEMS) { toast("A list holds at most " + MAX_ITEMS + " items."); return false; }
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-media-id") === mediaId) { toast("Already in the list."); return false; }
    }
    var li = tpl.content.firstElementChild.cloneNode(true);
    li.setAttribute("data-media-id", mediaId);
    qs(".t", li).textContent = title;
    qs("textarea", li).value = blurb || "";
    container.appendChild(li);
    renumber(container);
    return true;
  }
  function renumber(container) {
    Array.prototype.forEach.call(container.querySelectorAll("[data-media-id]"), function (li, i) {
      qs(".rank", li).textContent = String(i + 1);
    });
    var empty = qs("[data-empty]", container.parentNode);
    if (empty) empty.hidden = container.querySelectorAll("[data-media-id]").length > 0;
  }
  function collectItems(container) {
    return Array.prototype.map.call(container.querySelectorAll("[data-media-id]"), function (li) {
      return { media_item_id: li.getAttribute("data-media-id"), blurb: qs("textarea", li).value };
    });
  }
  function flash(p, btn, after) {
    if (btn) btn.disabled = true;
    return p.then(function (r) {
      if (btn) btn.disabled = false;
      if (after) after(r);
    }, function (e) {
      if (btn) btn.disabled = false;
      toast(e.message);
    });
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!el || el.tagName === "FORM") return;
    var a = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    if (a === "list-public") {
      var next = el.getAttribute("data-public") !== "true";
      done(call("PATCH", "/api/lists/" + encodeURIComponent(id), { is_public: next }), el);
    } else if (a === "list-delete") {
      if (!window.confirm("Delete this list? Its items stay in your library.")) return;
      flash(call("DELETE", "/api/lists/" + encodeURIComponent(id)), el, function () { location.href = "/lists"; });
    } else if (a === "copy-share") {
      var url = shareUrl(el.getAttribute("data-slug"));
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast("Share link copied."); }, function () { toast(url); });
      } else { toast(url); }
    } else if (a === "row-up" || a === "row-down" || a === "row-remove") {
      var li = el.closest("[data-media-id]");
      var box = li && li.parentNode;
      if (!li) return;
      if (a === "row-up" && li.previousElementSibling) box.insertBefore(li, li.previousElementSibling);
      else if (a === "row-down" && li.nextElementSibling) box.insertBefore(li.nextElementSibling, li);
      else if (a === "row-remove") box.removeChild(li);
      renumber(box);
    } else if (a === "pick-add") {
      var added = addItemRow(document.getElementById("list-items"), id, el.getAttribute("data-title") || "", "");
      if (added) el.disabled = true;
    } else if (a === "list-save") {
      var lid = el.getAttribute("data-id");
      flash(call("PUT", "/api/lists/" + encodeURIComponent(lid) + "/items", { items: collectItems(document.getElementById("list-items")) }), el, function () {
        toast("Saved");
      });
    } else if (a === "draft-save") {
      var box2 = document.getElementById("draft-items");
      var body = {
        title: document.getElementById("draft-title").value.trim(),
        description: document.getElementById("draft-desc").value
      };
      if (!body.title) { toast("Give the draft a title."); return; }
      var ft = document.getElementById("draft-filter").value;
      if (ft) body.media_type_filter = ft;
      var items = collectItems(box2);
      flash(call("POST", "/api/lists", body).then(function (l) {
        return call("PUT", "/api/lists/" + encodeURIComponent(l.id) + "/items", { items: items }).then(function () { return l; });
      }), el, function (l) { location.href = "/lists/" + encodeURIComponent(l.id); });
    }
  });
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var a = form.getAttribute && form.getAttribute("data-action");
    if (a !== "list-create" && a !== "list-meta" && a !== "draft" && a !== "pick") return;
    ev.preventDefault();
    var btn = form.querySelector("button[type=submit]");
    var fd = new FormData(form);
    var ft = String(fd.get("media_type") || "");
    if (a === "list-create") {
      var body = { title: String(fd.get("title") || "").trim(), description: String(fd.get("description") || "") };
      if (ft) body.media_type_filter = ft;
      flash(call("POST", "/api/lists", body), btn, function (l) { location.href = "/lists/" + encodeURIComponent(l.id); });
    } else if (a === "list-meta") {
      var id = form.getAttribute("data-id");
      flash(call("PATCH", "/api/lists/" + encodeURIComponent(id), {
        title: String(fd.get("title") || "").trim(),
        description: String(fd.get("description") || ""),
        media_type_filter: ft || null
      }), btn, function () { toast("Saved"); });
    } else if (a === "draft") {
      var db = { prompt: String(fd.get("prompt") || "") };
      if (ft) db.media_type = ft;
      flash(call("POST", "/api/lists/draft", db), btn, function (d) {
        document.getElementById("draft-title").value = d.title || "";
        document.getElementById("draft-desc").value = d.description || "";
        document.getElementById("draft-filter").value = ft;
        var box = document.getElementById("draft-items");
        box.textContent = "";
        (d.items || []).forEach(function (it) { addItemRow(box, it.media_item_id, it.title, it.blurb); });
        document.getElementById("draft-panel").hidden = false;
        renumber(box);
      });
    } else if (a === "pick") {
      var q = String(fd.get("q") || "").trim();
      var out = document.getElementById("pick-results");
      flash(call("GET", "/api/items?limit=20&sort=title&order=asc&q=" + encodeURIComponent(q)), btn, function (r) {
        out.textContent = "";
        var its = r.items || [];
        if (its.length === 0) { out.textContent = "No matches."; return; }
        its.forEach(function (it) {
          var b = document.createElement("button");
          b.type = "button";
          b.setAttribute("data-action", "pick-add");
          b.setAttribute("data-id", it.id);
          b.setAttribute("data-title", it.title);
          b.textContent = "+ " + it.title + " (" + it.mediaType + ")";
          out.appendChild(b);
        });
      });
    }
  });
})();
`;
