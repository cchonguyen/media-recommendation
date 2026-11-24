// Static client script, injected inline. Never interpolates row data.
export const CLIENT_SCRIPT = `
(function () {
  var SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON_ALERT = SVG_OPEN + '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>';
  var ICON_INFO = SVG_OPEN + '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
  var ICON_CHECK = SVG_OPEN + '<path d="M20 6 9 17l-5-5"/></svg>';
  var STAR_PATH = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
  var STAR_HALF_PATH = '<path class="app-star__half-fill" d="M12 2L8.91 8.26 2 9.27l5 4.87-1.18 6.88L12 17.77Z"/>' + STAR_PATH;
  var MENU_ICONS = {
    "film": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    "tv": '<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
    "book-open": '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    "gamepad-2": '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    "mic": '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    "bookmark": '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    "layers": '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    "list-ordered": '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    "play": '<polygon points="6 3 20 12 6 21 6 3"/>',
    "pause": '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    "check": '<path d="M20 6 9 17l-5-5"/>',
    "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    "archive": '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    "award": '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
    "calendar": '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    "sliders-horizontal": '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'
  };
  var activeMenu = null;
  function closeMenu(refocus) {
    if (!activeMenu) return;
    var m = activeMenu;
    activeMenu = null;
    document.removeEventListener("click", m.onDoc, true);
    document.removeEventListener("keydown", m.onKey, true);
    window.removeEventListener("resize", m.onWin);
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    m.trigger.setAttribute("aria-expanded", "false");
    if (refocus && m.trigger.focus) m.trigger.focus();
  }
  function openMenu(trigger) {
    if (activeMenu && activeMenu.trigger === trigger) { closeMenu(true); return; }
    closeMenu(false);
    var opts = [];
    try { opts = JSON.parse(trigger.getAttribute("data-menu-options") || "[]"); } catch (e) { opts = []; }
    var wrap = trigger.closest ? trigger.closest(".app-menu-wrap") : null;
    var inp = wrap ? wrap.querySelector('input[type="hidden"]') : null;
    var variant = wrap ? wrap.getAttribute("data-menu-variant") : "field";
    var cur = inp ? inp.value : "";
    var menu = mk("div", "ui-menu app-floating-menu");
    menu.setAttribute("role", "listbox");
    var optBtns = [];
    opts.forEach(function (o) {
      var b = mk("button", "ui-menu-item");
      b.type = "button";
      b.setAttribute("role", "option");
      var isSel = o.v === cur;
      b.setAttribute("aria-selected", isSel ? "true" : "false");
      var ico = mk("span");
      ico.innerHTML = SVG_OPEN + (MENU_ICONS[o.i] || "") + "</svg>";
      if (ico.firstChild) b.appendChild(ico.firstChild);
      b.appendChild(mk("span", "", o.l));
      if (isSel) {
        var chk = mk("span", "ui-menu-item__check");
        chk.innerHTML = ICON_CHECK;
        b.appendChild(chk);
      }
      b.addEventListener("click", function () {
        if (inp) inp.value = o.v;
        var svg = trigger.querySelector("svg");
        if (svg && MENU_ICONS[o.i]) svg.innerHTML = MENU_ICONS[o.i];
        var lbl = trigger.querySelector(".app-menu-trigger__label");
        if (lbl) lbl.textContent = o.l;
        if (variant === "icon") trigger.setAttribute("title", o.l);
        if (variant === "status") {
          trigger.className = "ui-btn app-menu-trigger app-status-select app-status-select--" + (o.t || "neutral");
        } else if (variant === "filter") {
          trigger.className = o.v ? "ui-filter-toggle ui-filter-toggle--yes app-filter-menu" : "ui-filter-toggle app-filter-menu";
        }
        closeMenu(true);
        if (inp) inp.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.appendChild(b);
      optBtns.push(b);
    });
    document.body.appendChild(menu);
    var r = trigger.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8 && r.top - mh - 4 >= 8) top = r.top - mh - 4;
    var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - mw - 8));
    menu.style.top = Math.round(top) + "px";
    menu.style.left = Math.round(left) + "px";
    menu.style.minWidth = Math.max(180, Math.round(r.width)) + "px";
    trigger.setAttribute("aria-expanded", "true");
    var onDoc = function (ev) { if (!menu.contains(ev.target) && !trigger.contains(ev.target)) closeMenu(false); };
    var onWin = function () { closeMenu(false); };
    var onKey = function (ev) {
      var idx = optBtns.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); optBtns[(idx + 1) % optBtns.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); optBtns[(idx - 1 + optBtns.length) % optBtns.length].focus(); }
      else if (ev.key === "Home") { ev.preventDefault(); optBtns[0].focus(); }
      else if (ev.key === "End") { ev.preventDefault(); optBtns[optBtns.length - 1].focus(); }
    };
    activeMenu = { el: menu, trigger: trigger, onDoc: onDoc, onKey: onKey, onWin: onWin };
    setTimeout(function () {
      document.addEventListener("click", onDoc, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onWin);
    }, 0);
    var selBtn = optBtns.filter(function (b) { return b.getAttribute("aria-selected") === "true"; })[0] || optBtns[0];
    if (selBtn) selBtn.focus();
  }
  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function toast(msg, opts) {
    opts = opts || {};
    var box = document.getElementById("toasts");
    if (!box) {
      box = mk("div", "ui-toasts");
      box.id = "toasts";
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    var t = mk("div", "ui-toast");
    t.setAttribute("role", "status");
    t.appendChild(mk("span", "ui-toast__msg", msg));
    var timer = null;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (t.parentNode) t.parentNode.removeChild(t);
    }
    function start() {
      clearTimeout(timer);
      if (!opts.sticky) timer = setTimeout(close, 6000);
    }
    function pause() { clearTimeout(timer); }
    if (opts.actionLabel) {
      var ab = mk("button", "ui-toast__action", opts.actionLabel);
      ab.type = "button";
      ab.addEventListener("click", function () {
        if (opts.onAction) opts.onAction();
        close();
      });
      t.appendChild(ab);
    }
    t.addEventListener("mouseenter", pause);
    t.addEventListener("focusin", pause);
    t.addEventListener("mouseleave", start);
    t.addEventListener("focusout", start);
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    start();
    return { close: close };
  }
  function notice(tone, msg, actions) {
    var box = document.getElementById("notices");
    if (!box) { toast(msg, { sticky: false }); return; }
    box.textContent = "";
    var n = mk("div", "ui-notice" + (tone === "bad" ? " ui-notice--bad" : tone === "warn" ? " ui-notice--warn" : ""));
    n.setAttribute("role", tone === "info" ? "status" : "alert");
    var holder = mk("span");
    holder.innerHTML = tone === "info" ? ICON_INFO : ICON_ALERT;
    if (holder.firstChild) n.appendChild(holder.firstChild);
    var body = mk("div", "ui-notice__body");
    body.appendChild(mk("span", "", msg));
    var acts = mk("div", "ui-notice__actions");
    (actions || []).forEach(function (a) {
      var b = mk("button", "ui-btn", a.label);
      b.type = "button";
      b.addEventListener("click", function () { a.run(); });
      acts.appendChild(b);
    });
    var dis = mk("button", "ui-btn ui-btn--ghost", "Dismiss");
    dis.type = "button";
    dis.addEventListener("click", function () { if (n.parentNode) n.parentNode.removeChild(n); });
    acts.appendChild(dis);
    body.appendChild(acts);
    n.appendChild(body);
    box.appendChild(n);
  }
  function confirmDialog(o) {
    return new Promise(function (resolve) {
      var opener = document.activeElement;
      var scrim = mk("div", "ui-scrim");
      var dlg = mk("div", "ui-dialog");
      dlg.setAttribute("role", "alertdialog");
      dlg.setAttribute("aria-modal", "true");
      dlg.setAttribute("aria-labelledby", "dlg-title");
      dlg.setAttribute("aria-describedby", "dlg-body");
      var head = mk("div", "ui-dialog__head");
      var h = mk("h2", "ui-dialog__title", o.title);
      h.id = "dlg-title";
      head.appendChild(h);
      var bd = mk("div", "ui-dialog__body");
      bd.id = "dlg-body";
      bd.appendChild(mk("p", "", o.body));
      var foot = mk("div", "ui-dialog__foot");
      var cancel = mk("button", "ui-btn ui-btn--ghost", "Cancel");
      cancel.type = "button";
      cancel.setAttribute("data-dlg", "cancel");
      var ok = mk("button", "ui-btn" + (o.danger ? " ui-btn--danger" : ""), o.confirmLabel);
      ok.type = "button";
      ok.setAttribute("data-dlg", "ok");
      foot.appendChild(cancel);
      foot.appendChild(ok);
      dlg.appendChild(head);
      dlg.appendChild(bd);
      dlg.appendChild(foot);
      scrim.appendChild(dlg);
      function finish(v) {
        document.removeEventListener("keydown", onKey, true);
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        if (opener && opener.focus && document.contains(opener)) opener.focus();
        resolve(v);
      }
      function onKey(ev) {
        if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        else if (ev.key === "Tab") {
          ev.preventDefault();
          var next = document.activeElement === cancel ? ok : cancel;
          next.focus();
        }
      }
      cancel.addEventListener("click", function () { finish(false); });
      ok.addEventListener("click", function () { finish(true); });
      scrim.addEventListener("click", function (ev) { if (ev.target === scrim) finish(false); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(scrim);
      cancel.focus();
    });
  }
  try {
    var pending = sessionStorage.getItem("flash");
    if (pending) { sessionStorage.removeItem("flash"); toast(pending); }
  } catch (e) { /* storage unavailable */ }
  function call(method, url, body, timeoutMs) {
    var ctl = timeoutMs && window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
    return fetch(url, {
      method: method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new Error("No answer after " + Math.round(timeoutMs / 1000) + " seconds. Your lines are safe in the Doc; try again in a minute.");
      throw new Error("Could not reach the server. Your lines are safe in the Doc.");
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
      notice("bad", e.message, [{ label: "Reload page", run: function () { location.reload(); } }]);
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
      var tk = toast("Sweeping the inbox... this can take up to a minute.", { sticky: true });
      call("POST", "/api/sweep", undefined, 60000).then(function (r) {
        tk.close();
        var msg;
        var reload = false;
        var skip = false;
        if (r.skipped === "no-inbox-doc") { msg = "Inbox is not configured: add the INBOX_DOC_ID secret."; skip = true; }
        else if (r.skipped === "nothing-to-do") { msg = "The inbox is empty. Add a line under the header in the Doc first."; skip = true; }
        else if (r.ingest) {
          var g = r.ingest;
          msg = g.created + " new, " + g.merged + " merged, " + g.skippedDuplicates + " already seen";
          if (g.unparsedLines && g.unparsedLines.length) msg += ", " + g.unparsedLines.length + " could not be read and were left in the Doc" + (g.rejected ? " (" + g.rejected + " parsed items were invalid)" : "");
          if (r.cleared === false) msg += ". The Doc could not be cleared; it will retry in 15 minutes.";
          reload = true;
        } else { msg = "Sweep finished."; }
        el.disabled = false;
        if (skip) { notice("info", msg, []); return; }
        toast(msg);
        if (reload) {
          try { sessionStorage.setItem("flash", msg); } catch (e) { /* storage unavailable */ }
          setTimeout(function () { location.reload(); }, 1200);
        }
      }, function (e) {
        tk.close();
        el.disabled = false;
        notice("bad", /Gemini|parser/i.test(e.message) ? e.message + " Your lines are safe in the Doc; try again in a minute." : e.message, [{ label: "Try again", run: function () { el.click(); } }]);
      });
    } else if (a === "test-parse") {
      if (el.disabled) return;
      el.disabled = true;
      var tk2 = toast("Reading the inbox with the parser... this can take up to a minute.", { sticky: true });
      call("POST", "/api/sweep/test-parse", undefined, 60000).then(function (r) {
        tk2.close();
        el.disabled = false;
        var out = document.getElementById("test-parse-result");
        if (r.skipped === "no-inbox-doc") { notice("info", "Inbox is not configured: add the INBOX_DOC_ID secret.", []); return; }
        if (r.skipped === "nothing-to-do") { notice("info", "The inbox is empty. Add a line under the header in the Doc first.", []); return; }
        var ls = r.lines || [];
        var ok = 0;
        ls.forEach(function (l) { if (l.ok) ok++; });
        toast("Test parse done.");
        if (!out) return;
        out.textContent = "";
        function withIcon(node, svg) {
          var hold = mk("span");
          hold.innerHTML = svg;
          if (hold.firstChild) node.appendChild(hold.firstChild);
        }
        var sum = mk("div", "ui-notice");
        sum.setAttribute("role", "status");
        withIcon(sum, ICON_INFO);
        sum.appendChild(mk("div", "ui-notice__body", "Parser would save " + ok + " of " + ls.length + " lines. Test only: nothing was saved and the Doc was not changed."));
        out.appendChild(sum);
        ls.forEach(function (l) {
          if (l.ok) return;
          var p = mk("div", "ui-notice ui-notice--bad");
          p.setAttribute("role", "alert");
          withIcon(p, ICON_ALERT);
          var pb = mk("div", "ui-notice__body");
          pb.appendChild(mk("span", "", "Could not read: " + l.line + " (" + (l.reason || "no parser could read this line") + ")"));
          var pa = mk("div", "ui-notice__actions");
          var again = mk("button", "ui-btn", "Test again");
          again.type = "button";
          again.setAttribute("data-action", "test-parse");
          pa.appendChild(again);
          pb.appendChild(pa);
          p.appendChild(pb);
          out.appendChild(p);
        });
        if (r.diag) out.appendChild(mk("p", "ui-data ui-muted", r.diag));
      }, function (e) {
        tk2.close();
        el.disabled = false;
        notice("bad", e.message, [{ label: "Try again", run: function () { el.click(); } }]);
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
      }, function (e) { el.disabled = false; notice("bad", e.message, [{ label: "Try again", run: function () { el.click(); } }]); });
    } else if (a === "archive") {
      confirmDialog({ title: "Archive this item?", body: "It is hidden from the library. Its history is kept.", confirmLabel: "Archive item", danger: false }).then(function (ok) {
        if (ok) done(call("DELETE", "/api/items/" + encodeURIComponent(id)), el);
      });
    } else if (a === "star-rate") {
      var n = Number(el.getAttribute("data-star"));
      var wrap = el.closest(".app-stars");
      if (!wrap || !n) return;
      var cur = Number(wrap.getAttribute("data-rating-value") || "0");
      var val;
      if (ev.detail > 0) {
        var rect = el.getBoundingClientRect();
        var isLeft = (ev.clientX - rect.left) < rect.width / 2;
        val = (isLeft && n > 1) ? n - 0.5 : n;
      } else {
        val = (cur === n && n > 1) ? n - 0.5 : n;
      }
      wrap.setAttribute("data-rating-value", String(val));
      var hidden = wrap.querySelector("input[type=hidden]");
      if (hidden) hidden.value = String(val);
      Array.prototype.forEach.call(wrap.querySelectorAll(".app-star"), function (btn) {
        var k = Number(btn.getAttribute("data-star"));
        var st = val >= k ? "full" : val >= k - 0.5 ? "half" : "empty";
        btn.className = st === "empty" ? "ui-icon-btn app-star" : "ui-icon-btn app-star app-star--" + st;
        btn.setAttribute("aria-pressed", st !== "empty" ? "true" : "false");
        btn.setAttribute("title", val.toFixed(1) + " / 5 — click to rate " + k);
        var svg = btn.querySelector("svg");
        if (svg) svg.innerHTML = st === "half" ? STAR_HALF_PATH : STAR_PATH;
      });
      if (wrap.getAttribute("data-stars-mode") === "inline" && id) {
        var cell = wrap.closest(".rating-cell");
        var trEl = cell ? cell.querySelector("[data-action=tier]") : null;
        var tr = trEl ? trEl.value : "";
        var rbody = { rating: val };
        if (tr) rbody.tier = tr;
        cellDone(call("POST", itemUrl(id) + "/rating", rbody), el);
      }
    } else if (a === "toggle-filters") {
      var panelId = el.getAttribute("aria-controls") || "filter-panel";
      var panel = document.getElementById(panelId);
      if (panel) {
        panel.hidden = !panel.hidden;
        el.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
      }
    } else if (a === "filter-toggle") {
      var fform = el.closest ? el.closest("[data-filter-form]") : null;
      var fname = el.getAttribute("data-filter-name");
      if (!fform || !fname) return;
      var finp = fform.querySelector('input[type="hidden"][name="' + fname + '"]');
      if (!finp) return;
      finp.value = finp.value === "" ? "yes" : finp.value === "yes" ? "no" : "";
      fform.submit();
    } else if (a === "open-menu") {
      openMenu(el);
    }
  });
  function cellDone(p, el) {
    el.disabled = true;
    p.then(function () { el.disabled = false; toast("Saved"); }, function (e) {
      el.disabled = false;
      notice("bad", e.message, [{ label: "Reload page", run: function () { location.reload(); } }]);
    });
  }
  function itemUrl(id) { return "/api/items/" + encodeURIComponent(id); }
  document.addEventListener("change", function (ev) {
    var el = ev.target;
    if (el.hasAttribute && el.hasAttribute("data-filter-auto")) {
      var fform = el.closest ? el.closest("[data-filter-form]") : null;
      if (fform) fform.submit();
      return;
    }
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
      el.setAttribute("aria-label", "Title of " + t);
      if (el.parentElement && el.parentElement.classList.contains("app-title-wrap")) {
        el.parentElement.setAttribute("data-tooltip", t);
      }
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
  // ---- Last sweeps panel. Server text is only ever set with textContent. ----
  (function () {
    var box = document.getElementById("sweeps");
    if (!box) return;
    fetch("/api/sweeps").then(function (r) { return r.json(); }).then(function (j) {
      var rows = (j && j.sweeps) || [];
      if (!rows.length) { box.appendChild(mk("p", "ui-missing app-empty", "No sweeps recorded yet.")); return; }
      rows.forEach(function (s) {
        var d = mk("div", "ui-card app-row ui-data");
        var when = new Date(s.startedAt);
        var text = (isNaN(when.getTime()) ? String(s.startedAt) : when.toLocaleString()) +
          " | " + s.trigger + " | " + s.outcome +
          " | " + s.created + " created, " + s.merged + " merged, " + s.keptInDoc + " kept, " + s.rejected + " rejected";
        var extra = s.error || s.diag;
        if (extra) text += " | " + extra;
        d.textContent = text;
        box.appendChild(d);
      });
    }, function () { box.textContent = ""; box.appendChild(mk("p", "ui-missing app-empty", "Could not load the sweep history.")); });
  })();
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
      notice("bad", e.message, []);
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
      confirmDialog({ title: "Delete this list?", body: "The list and its ranking are removed and its share link stops working. The items stay in your library.", confirmLabel: "Delete list", danger: true }).then(function (ok) {
        if (ok) flash(call("DELETE", "/api/lists/" + encodeURIComponent(id)), el, function () { location.href = "/lists"; });
      });
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
        if (its.length === 0) { out.appendChild(mk("p", "ui-missing app-empty", "No matches.")); return; }
        its.forEach(function (it) {
          var b = mk("button", "ui-btn");
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
