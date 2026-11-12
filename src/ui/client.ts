// Static client script, injected inline. Never interpolates row data.
export const CLIENT_SCRIPT = `
(function () {
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(function () { t.hidden = true; }, 6000);
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
      el.disabled = true;
      call("POST", "/api/sweep").then(function (r) {
        toast("Sweep done: " + JSON.stringify(r));
        setTimeout(function () { location.reload(); }, 1200);
      }, function (e) { el.disabled = false; toast(e.message); });
    } else if (a === "backup") {
      toast("Backup is coming soon.");
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
})();
`;
