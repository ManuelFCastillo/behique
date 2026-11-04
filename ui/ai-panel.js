// The "AI stages" card of the dashboard: what Spark proposed on the open report and what code could check about it,
// and a way to ask for more (capped, on a saved report). Self-contained on purpose: it reads the dashboard's global
// `LIVE` and draws one card after #askCard. Everything it shows is an AI guess; none of it can change the verdict.
(function () {
  "use strict";
  var CSS = [
    ".aicard{padding:14px 16px;margin-top:12px;font-size:13px}",
    ".aicard h2{font-size:15px;margin:0}",
    ".aicard .ai-sub{color:var(--muted);font-size:12px;margin:2px 0 10px}",
    ".aicard .ai-tag{display:inline-block;border:1px solid var(--purple);color:var(--purple);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.04em;margin-left:8px}",
    ".aicard .ai-stage{border-top:1px solid var(--line);padding:10px 0}",
    ".aicard .ai-stage-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}",
    ".aicard .ai-stage-head b{font-size:13px}",
    ".aicard .ai-count{font-size:12px;color:var(--muted)}",
    ".aicard .ai-cost{margin-left:auto;font-size:12px;color:var(--muted)}",
    ".aicard ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:6px}",
    ".aicard{min-width:0;max-width:100%;overflow:hidden}",
    ".aicard li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;font-size:13px;overflow-wrap:anywhere}",
    ".aicard li>span:nth-child(2){display:block;min-width:0}",
    ".aicard li>.ai-src{grid-column:1/-1;margin-top:0}",
    ".aicard .ai-chip{font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}",
    ".aicard .ai-chip.verified{color:var(--emerald);border-color:var(--emerald)}",
    ".aicard .ai-chip.replayed{color:var(--blue);border-color:var(--blue)}",
    ".aicard .ai-chip.failed{color:var(--ruby);border-color:var(--ruby)}",
    ".aicard .ai-detail{display:block;color:var(--muted);font-size:12px;margin-top:2px}",
    ".aicard .ai-note{color:var(--muted);font-size:12px;margin-top:6px}",
    ".aicard .ai-src{display:block;margin-top:4px;min-width:0;max-width:100%}",
    ".aicard .ai-src-row{display:flex;gap:12px}",
    // the code wraps inside the card instead of running past it; indentation is kept
    ".aicard pre.ai-code{display:block;box-sizing:border-box;width:100%;max-width:100%;background:#0a0e14;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d6deeb;max-height:420px;overflow:auto;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;tab-size:2}",
    ".aicard pre.ai-code[hidden]{display:none}",
    ".ai-code .tk-kw{color:#c792ea}.ai-code .tk-str{color:#ecc48d}.ai-code .tk-num{color:#f78c6c}.ai-code .tk-com{color:#637777;font-style:italic}",
    ".ai-code .tk-fn{color:#82aaff}.ai-code .tk-prop{color:#7fdbca}.ai-code .tk-type{color:#ffcb6b}.ai-code .tk-lit{color:#ff5874}.ai-code .tk-pun{color:#89a4b5}",
    ".aicard .ai-empty{color:var(--muted);font-size:13px;padding:8px 0}",
    ".aicard .ai-ask{border-top:1px solid var(--line);margin-top:6px;padding-top:12px}",
    ".aicard .ai-opts{display:grid;gap:6px;margin:6px 0 10px}",
    ".aicard label.ai-opt{display:grid;grid-template-columns:auto 1fr;gap:8px;font-size:13px;cursor:pointer}",
    ".aicard .ai-opt small{display:block;color:var(--muted);font-size:12px}",
    ".aicard .ai-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
    ".aicard select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12px}",
    ".aicard pre.ai-log{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;font-size:11px;max-height:150px;overflow:auto;margin-top:8px;white-space:pre-wrap}",
    ".aicard .ai-err{color:var(--ruby);font-size:12px;margin-top:6px}",
  ].join("\n");

  var state = { id: null, data: null, run: null, picked: { tests: true, flows: true, describe: true, triage: true, canvas: false }, budget: "0.25", busy: false, err: null, timer: null };
  var card = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function usd(n) { return "$" + Number(n || 0).toFixed(4); }
  function chipClass(s) { return s === "verified" ? "verified" : s === "replayed" ? "replayed" : s === "failed" ? "failed" : ""; }

  function mount() {
    if (card) return card;
    var anchor = document.getElementById("askCard");
    if (!anchor || !anchor.parentNode) return null;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    card = el("section", "card aicard"); card.id = "aiCard"; card.hidden = true; card.setAttribute("aria-live", "polite");
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    return card;
  }

  function getJSON(url, opts) { return fetch(url, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : "request failed"); return j; }); }); }

  function load(id) {
    return getJSON("/api/ui/ai?id=" + encodeURIComponent(id)).then(function (d) {
      if (state.id !== id) return;
      state.data = d; state.run = d.run || null; state.err = null; draw();
      if (state.run && state.run.running) poll();
    }).catch(function (e) { if (state.id === id) { state.data = null; state.err = e.message; draw(); } });
  }

  function poll() {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      getJSON("/api/ui/ai/run").then(function (r) {
        state.run = r; draw();
        if (r.running) poll(); else if (state.id) load(state.id);
      }).catch(function () { poll(); });
    }, 1500);
  }

  function start() {
    var stages = Object.keys(state.picked).filter(function (k) { return state.picked[k]; });
    state.busy = true; state.err = null; draw();
    getJSON("/api/ui/ai/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.id, stages: stages, budget: state.budget }) })
      .then(function (r) { state.run = r; state.busy = false; draw(); poll(); })
      .catch(function (e) { state.busy = false; state.err = e.message; draw(); });
  }

  function cancel() { getJSON("/api/ui/ai/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(function (r) { state.run = r; draw(); }).catch(function () {}); }

  // A small TypeScript/JavaScript colouring: comments, strings, numbers, keywords, calls, properties, types. Text nodes only, never markup.
  var KW = {}; ("import export from const let var function async await return if else for while do of in new try catch finally throw typeof instanceof class extends type interface as default break continue switch case void delete static readonly enum implements public private").split(" ").forEach(function (k) { KW[k] = 1; });
  var LIT = { "true": 1, "false": 1, "null": 1, "undefined": 1, "this": 1, "NaN": 1, "Infinity": 1 };
  var TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:<>=+\-*\/%&|!?^~@#]+)|(\s+)|([\s\S])/g;
  function highlight(src) {
    var frag = document.createDocumentFragment(), prevDot = false, m, rest;
    function put(cls, text) { if (!cls) { frag.appendChild(document.createTextNode(text)); return; } var s = document.createElement("span"); s.className = "tk-" + cls; s.textContent = text; frag.appendChild(s); }
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src)) !== null) {
      if (m[1]) { put("com", m[0]); prevDot = false; }
      else if (m[2]) { put("str", m[0]); prevDot = false; }
      else if (m[3]) { put("num", m[0]); prevDot = false; }
      else if (m[4]) {
        var w = m[0]; rest = src.slice(TOKEN.lastIndex).match(/^\s*(\(|<[^>\n]*>\s*\()/);
        put(LIT[w] ? "lit" : KW[w] && !prevDot ? "kw" : rest ? "fn" : prevDot ? "prop" : /^[A-Z]/.test(w) ? "type" : null, w); prevDot = false;
      }
      else if (m[5]) { put("pun", m[0]); prevDot = /\.$/.test(m[0]); }
      else { put(null, m[0]); if (!m[6]) prevDot = false; }
    }
    return frag;
  }

  // Show, copy and download one AI-written test. The source is the exact file Behique ran; it is drawn as text only.
  function sourceBlock(it) {
    var wrap = el("span", "ai-src");
    var row = el("span", "ai-src-row");
    var pre = el("pre", "ai-code"); pre.appendChild(highlight(it.source)); pre.hidden = true;
    var show = el("button", "tiny-link", "Show test"); show.type = "button";
    show.addEventListener("click", function () { pre.hidden = !pre.hidden; show.textContent = pre.hidden ? "Show test" : "Hide test"; });
    var copy = el("button", "tiny-link", "Copy"); copy.type = "button";
    copy.addEventListener("click", function () {
      var done = function (ok) { copy.textContent = ok ? "Copied" : "Copy failed"; setTimeout(function () { copy.textContent = "Copy"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(it.source).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
    var dl = el("button", "tiny-link", "Download"); dl.type = "button";
    dl.addEventListener("click", function () {
      var a = document.createElement("a"), name = (it.id || "ai-test").replace(/[^\w.-]/g, "_") + ".spec.js";
      a.href = URL.createObjectURL(new Blob([it.source], { type: "text/javascript" })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    row.appendChild(show); row.appendChild(copy); row.appendChild(dl);
    wrap.appendChild(row); wrap.appendChild(pre);
    return wrap;
  }

  function stageBlock(s) {
    var box = el("div", "ai-stage");
    var head = el("div", "ai-stage-head");
    head.appendChild(el("b", null, s.title));
    var checked = s.items.filter(function (it) { return it.status === "verified" || it.status === "replayed"; }).length;
    var count = s.status === "ran" ? checked + " of " + s.total + " checked by code" : s.status === "skipped" ? "skipped" : s.status;
    head.appendChild(el("span", "ai-count", count));
    head.appendChild(el("span", "ai-cost", s.calls + " call" + (s.calls === 1 ? "" : "s") + " . " + usd(s.estUsd)));
    box.appendChild(head);
    if (s.reason) box.appendChild(el("div", "ai-note", s.reason));
    if (s.items.length) {
      var ul = el("ul");
      s.items.forEach(function (it) {
        var li = el("li");
        li.appendChild(el("span", "ai-chip " + chipClass(it.status), it.status));
        var body = el("span"); body.appendChild(document.createTextNode(it.text));
        if (it.detail) body.appendChild(el("span", "ai-detail", it.detail));
        li.appendChild(body);
        if (it.source) li.appendChild(sourceBlock(it)); // spans the whole row, under the chip and the text
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    s.notes.forEach(function (n) { box.appendChild(el("div", "ai-note", n)); });
    return box;
  }

  function askBlock(vm) {
    var box = el("div", "ai-ask");
    var running = !!(state.run && state.run.running);
    box.appendChild(el("div", "label", "Ask for more"));
    var opts = el("div", "ai-opts");
    (state.data.available || []).forEach(function (a) {
      var lab = el("label", "ai-opt");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!state.picked[a.id]; cb.disabled = running || state.busy;
      cb.addEventListener("change", function () { state.picked[a.id] = cb.checked; draw(); });
      var t = el("span"); t.appendChild(document.createTextNode(a.title)); t.appendChild(el("small", null, a.what + (a.needsApp ? " Builds the app." : "")));
      lab.appendChild(cb); lab.appendChild(t); opts.appendChild(lab);
    });
    box.appendChild(opts);
    var row = el("div", "ai-row");
    var sel = document.createElement("select"); sel.disabled = running || state.busy;
    ["0.10", "0.25", "0.50", "1.00"].forEach(function (v) { var o = el("option", null, "up to $" + v); o.value = v; if (v === state.budget) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { state.budget = sel.value; draw(); });
    var any = Object.keys(state.picked).some(function (k) { return state.picked[k]; });
    var btn = el("button", "mini-btn", running ? "Running" : "Run (up to $" + state.budget + ")"); btn.type = "button";
    btn.disabled = running || state.busy || !any || vm.verdict === "running";
    btn.addEventListener("click", start);
    row.appendChild(sel); row.appendChild(btn);
    if (running) { var c = el("button", "tiny-link", "Cancel"); c.type = "button"; c.addEventListener("click", cancel); row.appendChild(c); }
    box.appendChild(row);
    box.appendChild(el("div", "ai-note", "Spark proposes, code checks, you decide. The spending cap is enforced before every call. The verdict and exit code are computed first and are never read by these stages."));
    if (state.run && state.run.lines && state.run.lines.length && (running || state.run.status === "failed" || state.run.status === "cancelled")) {
      var pre = el("pre", "ai-log", state.run.lines.join("\n")); box.appendChild(pre); pre.scrollTop = pre.scrollHeight;
      if (state.run.status === "failed") box.appendChild(el("div", "ai-err", "The run did not finish (exit code " + state.run.code + "). The last lines above say why."));
    }
    if (state.err) box.appendChild(el("div", "ai-err", state.err));
    return box;
  }

  function draw() {
    var c = mount(); if (!c) return;
    var vm = (typeof LIVE !== "undefined" && LIVE.vm) || null;
    if (!vm || !state.id) { c.hidden = true; return; }
    c.hidden = false; c.textContent = "";
    var head = el("div", "ev-head");
    var h = el("h2", null, "AI stages"); h.appendChild(el("span", "ai-tag", "AI guesses, not proof")); head.appendChild(h);
    head.appendChild(el("span", "ask-count", state.data ? usd(state.data.totalUsd) + " spent on these" : ""));
    c.appendChild(head);
    c.appendChild(el("div", "ai-sub", "Spark proposes. Code checks each claim against the recorded evidence. These never change the verdict."));
    if (state.data) {
      if (!state.data.stages.length) c.appendChild(el("div", "ai-empty", "No AI stages have been run on this report yet."));
      state.data.stages.forEach(function (s) { c.appendChild(stageBlock(s)); });
      c.appendChild(askBlock(vm));
    } else if (state.err) c.appendChild(el("div", "ai-err", state.err));
  }

  function tick() {
    var id = (typeof LIVE !== "undefined" && LIVE.vm && LIVE.vm.id) || null;
    if (id !== state.id) { state.id = id; state.data = null; state.run = null; state.err = null; clearTimeout(state.timer); draw(); if (id) load(id); }
  }

  window.AIPANEL = { refresh: function () { if (state.id) load(state.id); } };
  document.addEventListener("DOMContentLoaded", function () { mount(); });
  setInterval(tick, 700);
})();
